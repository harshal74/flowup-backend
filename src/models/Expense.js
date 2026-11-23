const mongoose = require("mongoose");

/**
 * Expense — a restaurant's operating expense (Financials feature).
 *
 * Tenant-scoped by String restaurantId (matches Order/Menu/RawMaterial/Setting).
 * Manual entry only (no recurring automation in this version). Used by the
 * financial summary as Operating Expenses (Σ amount over expenseDate range).
 *
 * Conventions follow existing FlowUp models: String restaurantId, ObjectId
 * refs, timestamps, uppercase enum, trimmed/length-capped strings.
 */

// Controlled, extensible category set. `OTHER` is the catch-all. Exported for
// reuse by the controller (validation) — mirrors RawMaterial.UNITS export.
const EXPENSE_CATEGORIES = [
  "STAFF_SALARY",
  "RENT",
  "ELECTRICITY",
  "WATER",
  "INTERNET",
  "GAS",
  "MAINTENANCE",
  "MARKETING",
  "CLEANING",
  "DELIVERY_CHARGES",
  "PLATFORM_FEES",
  "EQUIPMENT",
  "OTHER",
];

const expenseSchema = new mongoose.Schema(
  {
    // Tenant key — ALWAYS set from authenticated context, never from the client.
    restaurantId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    category: {
      type: String,
      required: true,
      trim: true,
      enum: EXPENSE_CATEGORIES,
    },

    description: {
      type: String,
      trim: true,
      maxlength: 300,
      default: "",
    },

    // Expense amount (>= 0). Rounded/validated in the controller to > 0.
    amount: {
      type: Number,
      required: true,
      min: 0,
    },

    // The date the expense applies to (used for date-range filtering).
    expenseDate: {
      type: Date,
      required: true,
    },

    // Optional staff reference (e.g. for STAFF_SALARY). Same-tenant enforced
    // in the controller.
    staffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },

    notes: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },

    // The admin who recorded this expense — set from req.user._id server-side.
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },
  },
  {
    timestamps: true, // createdAt / updatedAt
  }
);

// ── Indexes ────────────────────────────────────────────────────────
// (1) Date-range queries per restaurant (summary + list, newest first).
expenseSchema.index({ restaurantId: 1, expenseDate: -1 });

// (2) Category breakdown / filtering per restaurant.
expenseSchema.index({ restaurantId: 1, category: 1 });

module.exports =
  mongoose.models.Expense || mongoose.model("Expense", expenseSchema);

// Exported for controller validation reuse (no secrets; pure enum).
module.exports.EXPENSE_CATEGORIES = EXPENSE_CATEGORIES;
