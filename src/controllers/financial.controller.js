const mongoose = require("mongoose");
const Expense = require("../models/Expense");
const Staff = require("../models/Staff");
const { EXPENSE_CATEGORIES } = Expense;
const financialService = require("../services/financial.service");

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

const EXPENSE_LIST_DEFAULT_LIMIT = 100;
const EXPENSE_LIST_MAX_LIMIT = 500;

// ── GET /api/financials/summary ─────────────────────────────────
// Admin-only, tenant-scoped P&L for a date range. All math in the service.
// Query: ?range=today|week|month|last_month|year|custom [&start=&end=]
const getSummary = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { range, start, end, offset } = req.query;

    const resolved = financialService.resolveRange(range || "month", start, end, offset);
    if (resolved.error) {
      return res.status(400).json({ success: false, message: resolved.error });
    }

    const summary = await financialService.computeSummary(
      restaurantId,
      resolved.start,
      resolved.end,
      resolved.label
    );

    return res.status(200).json({ success: true, data: summary });
  } catch (error) {
    console.error("Financials Summary Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── GET /api/financials/expenses ────────────────────────────────
// Admin-only, tenant-scoped list. Optional ?range=&start=&end=&category=.
const listExpenses = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { range, start, end, category, offset } = req.query;

    const filter = { restaurantId };

    // Optional date-range filter (by expenseDate).
    if (range) {
      const resolved = financialService.resolveRange(range, start, end, offset);
      if (resolved.error) {
        return res.status(400).json({ success: false, message: resolved.error });
      }
      filter.expenseDate = { $gte: resolved.start, $lte: resolved.end };
    }

    // Optional category filter (validated).
    if (category) {
      if (!EXPENSE_CATEGORIES.includes(category)) {
        return res.status(400).json({ success: false, message: "Invalid category" });
      }
      filter.category = category;
    }

    const limit = Math.min(
      Math.max(Number(req.query.limit) || EXPENSE_LIST_DEFAULT_LIMIT, 1),
      EXPENSE_LIST_MAX_LIMIT
    );
    const page = Math.max(Number(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;

    const [expenses, total] = await Promise.all([
      Expense.find(filter)
        .populate("staffId", "name role")
        .populate("createdBy", "name")
        .sort({ expenseDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Expense.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      count: expenses.length,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: expenses,
    });
  } catch (error) {
    console.error("List Expenses Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Shared validation for create/update. Returns { ok, value } or { ok:false, status, message }.
async function validateExpenseInput(body, restaurantId, { partial = false } = {}) {
  const out = {};

  // category
  if (body.category !== undefined) {
    if (!EXPENSE_CATEGORIES.includes(body.category)) {
      return { ok: false, status: 400, message: `category must be one of: ${EXPENSE_CATEGORIES.join(", ")}` };
    }
    out.category = body.category;
  } else if (!partial) {
    return { ok: false, status: 400, message: "category is required" };
  }

  // amount (> 0)
  if (body.amount !== undefined) {
    const amt = Number(body.amount);
    if (!isFiniteNumber(amt) || amt <= 0) {
      return { ok: false, status: 400, message: "amount must be a number greater than 0" };
    }
    out.amount = Math.round(amt * 100) / 100;
  } else if (!partial) {
    return { ok: false, status: 400, message: "amount is required" };
  }

  // expenseDate (valid date)
  // Parse the YYYY-MM-DD calendar input as LOCAL midnight so that the stored
  // UTC value reflects the intended calendar date in the server's local timezone.
  // Using `new Date("2026-10-31")` would produce UTC midnight (Oct 30 23:30 IST)
  // causing date-shift bugs. Appending T00:00:00 (no Z) forces local parsing.
  if (body.expenseDate !== undefined) {
    const raw = String(body.expenseDate);
    // Accept YYYY-MM-DD or ISO string; normalise to local midnight.
    const localStr = /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())
      ? `${raw.trim()}T00:00:00`      // local midnight — no timezone offset
      : raw;
    const d = new Date(localStr);
    if (isNaN(d.getTime())) {
      return { ok: false, status: 400, message: "expenseDate must be a valid date" };
    }
    out.expenseDate = d;
  } else if (!partial) {
    return { ok: false, status: 400, message: "expenseDate is required" };
  }

  // description (optional string)
  if (body.description !== undefined) {
    out.description = String(body.description).trim().slice(0, 300);
  }

  // notes (optional string)
  if (body.notes !== undefined) {
    out.notes = String(body.notes).trim().slice(0, 500);
  }

  // staffId (optional; must be same-tenant Staff)
  if (body.staffId !== undefined) {
    if (body.staffId === null || body.staffId === "") {
      out.staffId = null;
    } else {
      if (!isValidId(body.staffId)) {
        return { ok: false, status: 400, message: "Invalid staffId" };
      }
      const staff = await Staff.findOne({ _id: body.staffId, restaurantId }).select("_id").lean();
      if (!staff) {
        return { ok: false, status: 400, message: "Staff not found for this restaurant" };
      }
      out.staffId = body.staffId;
    }
  }

  return { ok: true, value: out };
}

// ── POST /api/financials/expenses ───────────────────────────────
const createExpense = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const validation = await validateExpenseInput(req.body || {}, restaurantId, { partial: false });
    if (!validation.ok) {
      return res.status(validation.status).json({ success: false, message: validation.message });
    }

    const expense = await Expense.create({
      ...validation.value,             // only whitelisted fields
      restaurantId,                    // server-derived — never from body
      createdBy: req.user._id || null, // server-derived
    });

    return res.status(201).json({ success: true, message: "Expense recorded successfully", data: expense });
  } catch (error) {
    console.error("Create Expense Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── PATCH /api/financials/expenses/:id ──────────────────────────
const updateExpense = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    const restaurantId = req.user.restaurantId;

    // Tenant-scoped existence check (foreign/nonexistent → 404, no data leak).
    const existing = await Expense.findOne({ _id: id, restaurantId }).select("_id").lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: "Expense not found" });
    }

    const validation = await validateExpenseInput(req.body || {}, restaurantId, { partial: true });
    if (!validation.ok) {
      return res.status(validation.status).json({ success: false, message: validation.message });
    }
    if (Object.keys(validation.value).length === 0) {
      return res.status(400).json({ success: false, message: "No valid fields to update" });
    }

    const updated = await Expense.findOneAndUpdate(
      { _id: id, restaurantId },      // tenant-scoped update
      validation.value,               // whitelisted only; restaurantId/createdBy never changed
      { returnDocument: "after", runValidators: true }
    )
      .populate("staffId", "name role")
      .populate("createdBy", "name");

    return res.status(200).json({ success: true, message: "Expense updated successfully", data: updated });
  } catch (error) {
    console.error("Update Expense Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── DELETE /api/financials/expenses/:id ─────────────────────────
const deleteExpense = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    const restaurantId = req.user.restaurantId;
    const deleted = await Expense.findOneAndDelete({ _id: id, restaurantId });
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Expense not found" });
    }

    return res.status(200).json({ success: true, message: "Expense deleted successfully" });
  } catch (error) {
    console.error("Delete Expense Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = {
  getSummary,
  listExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
};
