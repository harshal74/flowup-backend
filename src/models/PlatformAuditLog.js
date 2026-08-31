const mongoose = require("mongoose");

const platformAuditLogSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      required: true,
      enum: [
        "RESTAURANT_CREATED",
        "RESTAURANT_SUSPENDED",
        "RESTAURANT_REACTIVATED",
        "RESTAURANT_SLUG_CHANGED",
        // Expiry management (these were missing — caused silent save failures)
        "RESTAURANT_EXPIRY_SET",
        "RESTAURANT_EXPIRY_CLEARED",
        // Subscription amount
        "SUBSCRIPTION_AMOUNT_UPDATED",
        // Finance transactions
        "FINANCE_REVENUE_ADDED",
        "FINANCE_INVESTMENT_ADDED",
        "FINANCE_EXPENSE_ADDED",
        "FINANCE_TRANSACTION_DELETED",
        "FINANCE_TRANSACTION_UPDATED",
        // Password management
        "ADMIN_PASSWORD_RESET",
      ],
    },

    restaurantId: {
      type: String,
      required: true,
      index: true,
    },

    restaurantName: {
      type: String,
      default: "",
    },

    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },

    performedByEmail: {
      type: String,
      default: "",
    },

    reason: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

platformAuditLogSchema.index({ createdAt: -1 });

module.exports =
  mongoose.models.PlatformAuditLog ||
  mongoose.model("PlatformAuditLog", platformAuditLogSchema);
