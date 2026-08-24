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
