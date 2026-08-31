/**
 * Platform Finance Controller
 * SUPER_ADMIN only — all routes protected by platformAuth middleware.
 *
 * Endpoints implemented here:
 *   GET  /api/platform/finance/summary
 *   GET  /api/platform/finance/transactions
 *   POST /api/platform/finance/revenue
 *   POST /api/platform/finance/investment
 *   POST /api/platform/finance/expense
 *   PATCH /api/platform/finance/transactions/:id
 *   DELETE /api/platform/finance/transactions/:id   (soft delete)
 *   GET  /api/platform/finance/restaurants          (subscription overview)
 *   PATCH /api/platform/restaurants/:restaurantId/subscription
 *
 * Profit formula:
 *   Net Profit = Σ REVENUE − Σ INVESTMENT − Σ EXPENSE
 */

const mongoose                  = require("mongoose");
const PlatformFinanceTransaction = require("../models/PlatformFinanceTransaction");
const PlatformAuditLog           = require("../models/PlatformAuditLog");
const Setting                    = require("../models/Setting");

// ── Helpers ────────────────────────────────────────────────────────

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a { $gte, $lte } date filter from optional dateFrom / dateTo strings. */
function buildDateFilter(dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return null;
  const filter = {};
  if (dateFrom) {
    const d = new Date(dateFrom);
    if (!isNaN(d.getTime())) filter.$gte = d;
  }
  if (dateTo) {
    // Include the entire dateTo day
    const d = new Date(dateTo);
    if (!isNaN(d.getTime())) {
      d.setHours(23, 59, 59, 999);
      filter.$lte = d;
    }
  }
  return Object.keys(filter).length ? filter : null;
}

function logAudit({ action, performedBy, restaurantId = null, restaurantName = null, metadata = {} }) {
  PlatformAuditLog.create({
    action,
    restaurantId:      restaurantId || "PLATFORM",
    restaurantName:    restaurantName || "Platform",
    performedBy:       performedBy._id,
    performedByEmail:  performedBy.email,
    metadata,
  }).catch(err => console.error("[Finance] audit log error:", err.message));
}

// ── GET /api/platform/finance/summary ────────────────────────────
exports.getFinanceSummary = async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;

    const dateFilter = buildDateFilter(dateFrom, dateTo);
    const baseMatch = { deletedAt: null };
    if (dateFilter) baseMatch.date = dateFilter;

    const agg = await PlatformFinanceTransaction.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: "$type",
          total: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]);

    const totals = { REVENUE: 0, INVESTMENT: 0, EXPENSE: 0 };
    const counts = { REVENUE: 0, INVESTMENT: 0, EXPENSE: 0 };

    agg.forEach(row => {
      if (row._id in totals) {
        totals[row._id] = row.total;
        counts[row._id] = row.count;
      }
    });

    const netProfit = totals.REVENUE - totals.INVESTMENT - totals.EXPENSE;

    // Restaurant subscription overview count
    const totalRestaurants = await Setting.countDocuments({});
    const withSubscription = await Setting.countDocuments({ subscriptionAmount: { $gt: 0 } });

    return res.status(200).json({
      success: true,
      data: {
        totalRevenue:     totals.REVENUE,
        totalInvestment:  totals.INVESTMENT,
        totalExpenses:    totals.EXPENSE,
        netProfit,
        transactionCounts: counts,
        totalRestaurants,
        restaurantsWithSubscription: withSubscription,
        formula: "Net Profit = Total Revenue − Total Investment − Total Expenses",
        // Date range applied (null = all time)
        dateFrom: dateFrom || null,
        dateTo:   dateTo   || null,
      },
    });
  } catch (error) {
    console.error("[Finance] getFinanceSummary error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ── GET /api/platform/finance/transactions ────────────────────────
exports.getTransactions = async (req, res) => {
  try {
    const {
      type, category, restaurantId,
      dateFrom, dateTo, search,
      page = 1, limit = 30,
      sortBy = "date", sortOrder = "desc",
    } = req.query;

    const effectiveLimit = Math.min(Number(limit) || 30, 200);
    const effectivePage  = Math.max(Number(page)  || 1,  1);
    const skip = (effectivePage - 1) * effectiveLimit;

    const match = { deletedAt: null };

    if (type && ["REVENUE", "INVESTMENT", "EXPENSE"].includes(type)) {
      match.type = type;
    }
    if (category) {
      match.category = { $regex: escapeRegex(category), $options: "i" };
    }
    if (restaurantId) {
      match.restaurantId = restaurantId;
    }

    const dateFilter = buildDateFilter(dateFrom, dateTo);
    if (dateFilter) match.date = dateFilter;

    if (search && search.trim()) {
      const q = escapeRegex(search.trim());
      match.$or = [
        { description:    { $regex: q, $options: "i" } },
        { notes:          { $regex: q, $options: "i" } },
        { restaurantName: { $regex: q, $options: "i" } },
        { category:       { $regex: q, $options: "i" } },
      ];
    }

    const SORT_WHITELIST = { date: "date", amount: "amount", createdAt: "createdAt", type: "type" };
    const sortField = SORT_WHITELIST[sortBy] || "date";
    const sortDir   = sortOrder === "asc" ? 1 : -1;

    const [total, transactions] = await Promise.all([
      PlatformFinanceTransaction.countDocuments(match),
      PlatformFinanceTransaction.find(match)
        .sort({ [sortField]: sortDir })
        .skip(skip)
        .limit(effectiveLimit)
        .lean(),
    ]);

    return res.status(200).json({
      success: true,
      data: transactions,
      pagination: {
        page: effectivePage,
        limit: effectiveLimit,
        total,
        totalPages: Math.ceil(total / effectiveLimit),
      },
    });
  } catch (error) {
    console.error("[Finance] getTransactions error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ── Shared transaction creator ─────────────────────────────────────
async function createTransaction(req, res, type) {
  try {
    const { amount, date, category, description, notes, restaurantId, paymentReference } = req.body;

    // Validate amount
    const numAmount = Number(amount);
    if (!amount || isNaN(numAmount) || !isFinite(numAmount) || numAmount <= 0) {
      return res.status(400).json({ success: false, message: "Amount must be a number greater than ₹0." });
    }

    // Validate date
    if (!date) {
      return res.status(400).json({ success: false, message: "Date is required." });
    }
    const parsedDate = new Date(date);
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ success: false, message: "Invalid date format." });
    }

    // Validate category
    const trimmedCategory = String(category || "").trim();
    if (!trimmedCategory) {
      return res.status(400).json({ success: false, message: "Category is required." });
    }
    if (trimmedCategory.length > 100) {
      return res.status(400).json({ success: false, message: "Category must be 100 characters or fewer." });
    }

    // Optional restaurant lookup for name snapshot
    let restaurantName = null;
    if (restaurantId) {
      const settings = await Setting.findOne({ restaurantId }).select("restaurantName").lean();
      if (!settings) {
        return res.status(404).json({ success: false, message: "Restaurant not found." });
      }
      restaurantName = settings.restaurantName;
    }

    const tx = await PlatformFinanceTransaction.create({
      type,
      category: trimmedCategory,
      amount:   Math.round(numAmount * 100) / 100,
      date:     parsedDate,
      description: String(description || "").trim().slice(0, 500),
      notes:       String(notes || "").trim().slice(0, 1000),
      restaurantId:     restaurantId || null,
      restaurantName:   restaurantName,
      paymentReference: paymentReference ? String(paymentReference).trim().slice(0, 200) : null,
      createdBy:        req.user._id,
      createdByEmail:   req.user.email,
    });

    const auditActionMap = {
      REVENUE:    "FINANCE_REVENUE_ADDED",
      INVESTMENT: "FINANCE_INVESTMENT_ADDED",
      EXPENSE:    "FINANCE_EXPENSE_ADDED",
    };

    logAudit({
      action:         auditActionMap[type],
      performedBy:    req.user,
      restaurantId:   restaurantId || null,
      restaurantName: restaurantName || null,
      metadata: {
        transactionId: tx._id.toString(),
        amount:        tx.amount,
        category:      tx.category,
        date:          tx.date.toISOString(),
      },
    });

    return res.status(201).json({
      success: true,
      message: `${type.charAt(0) + type.slice(1).toLowerCase()} transaction recorded.`,
      data: tx,
    });
  } catch (error) {
    console.error(`[Finance] create ${type} error:`, error.message);
    return res.status(500).json({ success: false, message: "Failed to save transaction." });
  }
}

// ── POST /api/platform/finance/revenue ───────────────────────────
exports.addRevenue    = (req, res) => createTransaction(req, res, "REVENUE");

// ── POST /api/platform/finance/investment ────────────────────────
exports.addInvestment = (req, res) => createTransaction(req, res, "INVESTMENT");

// ── POST /api/platform/finance/expense ───────────────────────────
exports.addExpense    = (req, res) => createTransaction(req, res, "EXPENSE");

// ── PATCH /api/platform/finance/transactions/:id ─────────────────
exports.updateTransaction = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid transaction ID." });
    }

    const tx = await PlatformFinanceTransaction.findOne({ _id: id, deletedAt: null });
    if (!tx) {
      return res.status(404).json({ success: false, message: "Transaction not found." });
    }

    const updates = {};
    const { amount, date, category, description, notes } = req.body;

    if (amount !== undefined) {
      const n = Number(amount);
      if (isNaN(n) || !isFinite(n) || n <= 0) {
        return res.status(400).json({ success: false, message: "Amount must be a number greater than ₹0." });
      }
      updates.amount = Math.round(n * 100) / 100;
    }
    if (date !== undefined) {
      const d = new Date(date);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ success: false, message: "Invalid date format." });
      }
      updates.date = d;
    }
    if (category !== undefined) {
      const c = String(category).trim();
      if (!c) return res.status(400).json({ success: false, message: "Category is required." });
      updates.category = c.slice(0, 100);
    }
    if (description !== undefined) updates.description = String(description).trim().slice(0, 500);
    if (notes !== undefined)       updates.notes       = String(notes).trim().slice(0, 1000);

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: "No valid fields to update." });
    }

    Object.assign(tx, updates);
    await tx.save();

    logAudit({
      action:      "FINANCE_TRANSACTION_UPDATED",
      performedBy: req.user,
      metadata:    { transactionId: tx._id.toString(), updates },
    });

    return res.status(200).json({ success: true, message: "Transaction updated.", data: tx });
  } catch (error) {
    console.error("[Finance] updateTransaction error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to update transaction." });
  }
};

// ── DELETE /api/platform/finance/transactions/:id (soft delete) ───
exports.deleteTransaction = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid transaction ID." });
    }

    const tx = await PlatformFinanceTransaction.findOne({ _id: id, deletedAt: null });
    if (!tx) {
      return res.status(404).json({ success: false, message: "Transaction not found." });
    }

    tx.deletedAt = new Date();
    tx.deletedBy = req.user._id;
    await tx.save();

    logAudit({
      action:      "FINANCE_TRANSACTION_DELETED",
      performedBy: req.user,
      metadata: {
        transactionId: tx._id.toString(),
        type:          tx.type,
        amount:        tx.amount,
        category:      tx.category,
      },
    });

    return res.status(200).json({ success: true, message: "Transaction deleted." });
  } catch (error) {
    console.error("[Finance] deleteTransaction error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to delete transaction." });
  }
};

// ── GET /api/platform/finance/restaurants ─────────────────────────
// Subscription overview: each restaurant with its configured amount
// and actual revenue received (from REVENUE transactions linked to it).
exports.getRestaurantFinanceOverview = async (req, res) => {
  try {
    // Load all restaurants with their subscription amount
    const restaurants = await Setting.find({})
      .select("restaurantId restaurantName accountStatus expiresAt subscriptionAmount createdAt")
      .sort({ restaurantName: 1 })
      .lean();

    if (restaurants.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const restaurantIds = restaurants.map(r => r.restaurantId);

    // Aggregate actual revenue received per restaurant
    const revenueAgg = await PlatformFinanceTransaction.aggregate([
      {
        $match: {
          type:         "REVENUE",
          deletedAt:    null,
          restaurantId: { $in: restaurantIds },
        },
      },
      {
        $group: {
          _id:            "$restaurantId",
          totalReceived:  { $sum: "$amount" },
          txCount:        { $sum: 1 },
          lastPaymentDate: { $max: "$date" },
        },
      },
    ]);

    const revenueMap = {};
    revenueAgg.forEach(r => {
      revenueMap[r._id] = {
        totalReceived:   r.totalReceived,
        txCount:         r.txCount,
        lastPaymentDate: r.lastPaymentDate,
      };
    });

    const data = restaurants.map(r => ({
      restaurantId:        r.restaurantId,
      restaurantName:      r.restaurantName,
      accountStatus:       r.accountStatus || "ACTIVE",
      expiresAt:           r.expiresAt || null,
      subscriptionAmount:  r.subscriptionAmount || 0,
      totalRevenueReceived: revenueMap[r.restaurantId]?.totalReceived   || 0,
      transactionCount:    revenueMap[r.restaurantId]?.txCount          || 0,
      lastPaymentDate:     revenueMap[r.restaurantId]?.lastPaymentDate  || null,
    }));

    return res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    console.error("[Finance] getRestaurantFinanceOverview error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ── PATCH /api/platform/restaurants/:restaurantId/subscription ─────
// Update the subscription amount for a restaurant.
exports.updateSubscriptionAmount = async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { subscriptionAmount } = req.body;

    const numAmount = Number(subscriptionAmount);
    if (subscriptionAmount === undefined || subscriptionAmount === null || subscriptionAmount === "") {
      return res.status(400).json({ success: false, message: "Subscription amount is required." });
    }
    if (isNaN(numAmount) || !isFinite(numAmount)) {
      return res.status(400).json({ success: false, message: "Subscription amount must be a valid number." });
    }
    if (numAmount < 0) {
      return res.status(400).json({ success: false, message: "Subscription amount cannot be negative." });
    }
    if (numAmount > 10000000) {
      return res.status(400).json({ success: false, message: "Subscription amount exceeds maximum allowed value." });
    }

    const settings = await Setting.findOne({ restaurantId });
    if (!settings) {
      return res.status(404).json({ success: false, message: "Restaurant not found." });
    }

    const oldAmount = settings.subscriptionAmount || 0;
    settings.subscriptionAmount = Math.round(numAmount * 100) / 100;
    await settings.save();

    logAudit({
      action:         "SUBSCRIPTION_AMOUNT_UPDATED",
      performedBy:    req.user,
      restaurantId,
      restaurantName: settings.restaurantName,
      metadata: {
        oldAmount,
        newAmount: settings.subscriptionAmount,
      },
    });

    return res.status(200).json({
      success: true,
      message: `Subscription amount updated to ₹${settings.subscriptionAmount}.`,
      data: {
        restaurantId,
        restaurantName:     settings.restaurantName,
        subscriptionAmount: settings.subscriptionAmount,
      },
    });
  } catch (error) {
    console.error("[Finance] updateSubscriptionAmount error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to update subscription amount." });
  }
};
