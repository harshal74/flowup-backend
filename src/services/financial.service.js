/**
 * FlowUp Financials — single source of truth for Profit & Loss calculations.
 *
 * All figures are computed here (never in React). Tenant-scoped by restaurantId
 * which the CALLER derives from req.user (never the client).
 *
 * Definitions (per approved requirements):
 *   • Revenue = Σ Order.totalAmount  WHERE status==="COMPLETED" AND
 *     paymentStatus==="PAID" AND createdAt in [start,end].  (Identical to the
 *     dashboard's rule — no second definition of sales.)
 *   • COGS    = Σ over DEDUCTION InventoryTransaction rows in [start,end] of
 *     abs(quantityDelta) × unitCost, where unitCost = row.unitCostSnapshot when
 *     present (accurate historical cost), else the material's CURRENT
 *     RawMaterial.purchasePrice (legacy fallback → cogsEstimated=true), else 0
 *     if the material no longer exists.
 *   • Gross Profit = Revenue − COGS
 *   • Operating Expenses = Σ Expense.amount WHERE expenseDate in [start,end]
 *   • Net Profit = Gross Profit − Operating Expenses
 *   • Profit Margin = Revenue>0 ? (Net Profit / Revenue) × 100 : 0
 *
 * No unit conversion (base-unit convention). Read-only w.r.t. inventory/orders.
 */

const Order = require("../models/Order");
const InventoryTransaction = require("../models/InventoryTransaction");
const RawMaterial = require("../models/RawMaterial");
const Expense = require("../models/Expense");

const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);
const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : 0);

/**
 * Resolve a date range from a preset (or custom start/end).
 * Uses local server-time day boundaries, consistent with the dashboard's
 * getDateRange. Returns { start, end } as Date objects (inclusive end).
 *
 * @param {string} preset one of: today, week, month, last_month, year, custom
 * @param {string|Date} [customStart]
 * @param {string|Date} [customEnd]
 * @param {number} [offset=0]  navigable presets only: 0 = current period,
 *   negative = that many periods in the PAST (e.g. -1 = previous month/week/
 *   day/year), positive = future. Ignored for `last_month` and `custom`.
 * @returns {{ start: Date, end: Date, label: string } | { error: string }}
 */
function resolveRange(preset, customStart, customEnd, offset) {
  const now = new Date();
  const off = Number.isFinite(Number(offset)) ? Math.trunc(Number(offset)) : 0;

  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const endOfDay   = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
  const fmtDay   = (d) => d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const fmtShort = (d) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

  switch (String(preset || "month").toLowerCase()) {
    case "today": {
      const base = new Date(now);
      base.setDate(now.getDate() + off);
      const start = startOfDay(base);
      const end = endOfDay(base);
      return { start, end, label: fmtDay(start) };
    }

    case "week": {
      // Week starts Monday (matches dashboard weekly convention).
      const day = now.getDay(); // 0=Sun
      const diffToMonday = day === 0 ? -6 : 1 - day;
      const start = startOfDay(new Date(now));
      start.setDate(now.getDate() + diffToMonday + off * 7);
      const end = endOfDay(new Date(start));
      end.setDate(start.getDate() + 6);
      return { start, end, label: `${fmtShort(start)} – ${fmtShort(end)}` };
    }

    case "month": {
      const start = startOfDay(new Date(now.getFullYear(), now.getMonth() + off, 1));
      const end = endOfDay(new Date(now.getFullYear(), now.getMonth() + off + 1, 0));
      return { start, end, label: start.toLocaleDateString("en-IN", { month: "long", year: "numeric" }) };
    }

    case "last_month": {
      // last_month is now navigable using the same monthly offset logic.
      // offset -1 from current month = one month ago (which is the original "last month").
      // We reuse month logic with offset adjusted by -1 so offset=0 → last month.
      // The caller passes offset directly; "last_month" preset means offset starts at -1.
      const start = startOfDay(new Date(now.getFullYear(), now.getMonth() - 1 + off, 1));
      const end = endOfDay(new Date(now.getFullYear(), now.getMonth() + off, 0));
      return { start, end, label: start.toLocaleDateString("en-IN", { month: "long", year: "numeric" }) };
    }

    case "year": {
      const y = now.getFullYear() + off;
      const start = startOfDay(new Date(y, 0, 1));
      const end = endOfDay(new Date(y, 11, 31));
      return { start, end, label: String(y) };
    }

    case "total": {
      // All-time: no date restriction. Use epoch as start and end-of-today as
      // upper boundary so future-dated test data is excluded and the query
      // remains correct if the DB has very old records.
      const start = new Date(0); // 1970-01-01T00:00:00.000Z
      const end = endOfDay(new Date(now));
      return { start, end, label: "All Time" };
    }

    case "custom": {
      const s = new Date(customStart);
      const e = new Date(customEnd);
      if (isNaN(s.getTime()) || isNaN(e.getTime())) {
        return { error: "Invalid custom date range" };
      }
      const start = startOfDay(s);
      const end = endOfDay(e);
      if (start > end) {
        return { error: "Start date must be on or before end date" };
      }
      return { start, end, label: `${fmtShort(start)} – ${fmtShort(end)}` };
    }

    default:
      return { error: "Invalid date range preset" };
  }
}

/** Revenue: Σ totalAmount over COMPLETED + PAID orders in range (dashboard rule). */
async function computeRevenue(restaurantId, start, end) {
  const [agg] = await Order.aggregate([
    {
      $match: {
        restaurantId,
        status: "COMPLETED",
        paymentStatus: "PAID",
        createdAt: { $gte: start, $lte: end },
      },
    },
    { $group: { _id: null, revenue: { $sum: "$totalAmount" } } },
  ]);
  return round2(agg?.revenue || 0);
}

/**
 * COGS from DEDUCTION rows in range. Uses unitCostSnapshot when present, else
 * the material's current purchasePrice (fallback → estimated), else 0.
 * @returns {{ cogs:number, cogsEstimated:boolean, estimatedLineCount:number }}
 */
async function computeCogs(restaurantId, start, end) {
  const deductions = await InventoryTransaction.find({
    restaurantId,
    type: "DEDUCTION",
    createdAt: { $gte: start, $lte: end },
  })
    .select("rawMaterialId quantityDelta unitCostSnapshot")
    .lean();

  if (!deductions.length) {
    return { cogs: 0, cogsEstimated: false, estimatedLineCount: 0 };
  }

  // Determine which rows need the legacy fallback (no usable snapshot).
  const needFallbackIds = new Set();
  for (const d of deductions) {
    const snap = Number(d.unitCostSnapshot);
    if (!Number.isFinite(snap)) needFallbackIds.add(String(d.rawMaterialId));
  }

  // Load current purchasePrice only for materials that need the fallback.
  let priceById = new Map();
  if (needFallbackIds.size > 0) {
    const ids = [...needFallbackIds];
    const mats = await RawMaterial.find({ restaurantId, _id: { $in: ids } })
      .select("purchasePrice")
      .lean();
    priceById = new Map(mats.map((m) => [String(m._id), Number(m.purchasePrice) || 0]));
  }

  let cogs = 0;
  let estimatedLineCount = 0;

  for (const d of deductions) {
    const qty = Math.abs(Number(d.quantityDelta) || 0);
    const snap = Number(d.unitCostSnapshot);
    let unitCost;
    if (Number.isFinite(snap)) {
      unitCost = snap; // accurate historical cost
    } else {
      // Legacy fallback: current price, or 0 if material no longer exists.
      unitCost = priceById.has(String(d.rawMaterialId))
        ? priceById.get(String(d.rawMaterialId))
        : 0;
      estimatedLineCount += 1;
    }
    const line = qty * (Number.isFinite(unitCost) ? unitCost : 0);
    if (Number.isFinite(line)) cogs += line;
  }

  return {
    cogs: round2(cogs),
    cogsEstimated: estimatedLineCount > 0,
    estimatedLineCount,
  };
}

/**
 * Operating expenses total + per-category breakdown for the range.
 * @returns {{ operatingExpenses:number, expenseByCategory:Array<{category,total}> }}
 */
async function computeExpenses(restaurantId, start, end) {
  const rows = await Expense.aggregate([
    { $match: { restaurantId, expenseDate: { $gte: start, $lte: end } } },
    { $group: { _id: "$category", total: { $sum: "$amount" } } },
    { $sort: { total: -1 } },
  ]);

  let operatingExpenses = 0;
  const expenseByCategory = rows.map((r) => {
    const total = round2(Number(r.total) || 0);
    operatingExpenses += total;
    return { category: r._id, total };
  });

  return { operatingExpenses: round2(operatingExpenses), expenseByCategory };
}

/**
 * Full P&L summary for a tenant + date range. Single source of truth.
 * @param {string} restaurantId  server-derived tenant id
 * @param {Date} start
 * @param {Date} end
 */
async function computeSummary(restaurantId, start, end, label) {
  const [revenue, cogsResult, expenseResult] = await Promise.all([
    computeRevenue(restaurantId, start, end),
    computeCogs(restaurantId, start, end),
    computeExpenses(restaurantId, start, end),
  ]);

  const { cogs, cogsEstimated, estimatedLineCount } = cogsResult;
  const { operatingExpenses, expenseByCategory } = expenseResult;

  const grossProfit = round2(revenue - cogs);
  const netProfit = round2(grossProfit - operatingExpenses);
  const profitMargin = revenue > 0 ? round1((netProfit / revenue) * 100) : 0;

  return {
    revenue,
    cogs,
    grossProfit,
    operatingExpenses,
    netProfit,
    profitMargin,
    cogsEstimated,
    estimatedLineCount,
    expenseByCategory,
    range: { start, end, label: label || null },
  };
}

module.exports = {
  resolveRange,
  computeRevenue,
  computeCogs,
  computeExpenses,
  computeSummary,
};
