const express = require("express");
const {
  exportCsv,
  getSummary,
  listExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
} = require("../controllers/financial.controller");
const protect = require("../middleware/auth.middleware");

const router = express.Router();

/**
 * Financials (Profit & Loss) — ADMIN ONLY.
 * Financial data is sensitive: every route uses the admin `protect` middleware
 * (no staff/adminOrStaff access). restaurantId + createdBy are always derived
 * from req.user in the controller — never trusted from the client.
 */

// P&L summary for a date range (revenue, COGS, gross/net profit, margin, breakdown).
router.get("/summary", protect, getSummary);

// CSV export (sales / expenses / summary) for a date range.
router.get("/export", protect, exportCsv);

// Expense CRUD (tenant-scoped, admin-only).
router.get("/expenses", protect, listExpenses);
router.post("/expenses", protect, createExpense);
router.patch("/expenses/:id", protect, updateExpense);
router.delete("/expenses/:id", protect, deleteExpense);

module.exports = router;
