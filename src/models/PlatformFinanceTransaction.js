/**
 * PlatformFinanceTransaction
 *
 * Tracks all financial transactions for the FlowUp platform business.
 * SUPER_ADMIN only — never exposed to restaurant admins, staff, or customers.
 *
 * Types:
 *   REVENUE    — money received (e.g. subscription payments from restaurants)
 *   INVESTMENT — capital put into the business by the owner
 *   EXPENSE    — operating costs (hosting, tools, etc.)
 *
 * Profit formula:
 *   Net Profit = Total REVENUE − Total INVESTMENT − Total EXPENSE
 *
 * Design notes:
 *   - subscriptionAmount on Setting = configured price (what a restaurant SHOULD pay)
 *   - A REVENUE transaction = money actually received. They are independent.
 *   - Designed for future automation: paymentReference and restaurantId fields
 *     allow automated subscription-payment entries to be added later.
 */

const mongoose = require("mongoose");

const platformFinanceTransactionSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["REVENUE", "INVESTMENT", "EXPENSE"],
      required: true,
      index: true,
    },

    category: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
      // Common categories — not an enum so SUPER_ADMIN can use free text
      // e.g. SUBSCRIPTION, HOSTING, DEVELOPMENT, MARKETING, OTHER
    },

    amount: {
      type: Number,
      required: true,
      min: [0.01, "Amount must be greater than 0"],
    },

    date: {
      type: Date,
      required: true,
      index: true,
    },

    description: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },

    notes: {
      type: String,
      default: "",
      trim: true,
      maxlength: 1000,
    },

    // Linked restaurant (nullable — investments/expenses may not be restaurant-specific)
    restaurantId: {
      type: String,
      default: null,
      index: true,
    },

    // Denormalized snapshot so reports remain accurate even if restaurant is renamed
    restaurantName: {
      type: String,
      default: null,
      trim: true,
    },

    // Optional payment reference (Razorpay order ID, bank ref, etc.) for future automation
    paymentReference: {
      type: String,
      default: null,
      trim: true,
      maxlength: 200,
    },

    // Soft delete support
    deletedAt: {
      type: Date,
      default: null,
    },

    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },

    // Who created the entry
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },

    createdByEmail: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for aggregation queries (finance summary by type + date range)
platformFinanceTransactionSchema.index({ type: 1, date: -1 });
platformFinanceTransactionSchema.index({ restaurantId: 1, type: 1 });
platformFinanceTransactionSchema.index({ createdAt: -1 });

// Ensure soft-deleted records are excluded from normal queries
// (callers must explicitly include { deletedAt: null } or use the helper)
platformFinanceTransactionSchema.index({ deletedAt: 1 });

module.exports =
  mongoose.models.PlatformFinanceTransaction ||
  mongoose.model("PlatformFinanceTransaction", platformFinanceTransactionSchema);
