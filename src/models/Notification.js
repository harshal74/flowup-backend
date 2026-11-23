const mongoose = require("mongoose");

/**
 * Notification — persisted, restaurant-scoped admin notifications (Inventory Step 4).
 *
 * Step 4 uses this for LOW_STOCK alerts, but the model is intentionally generic
 * (type enum) so future notification kinds can reuse it. Persisted so alerts
 * survive page refresh; delivered in real time via the existing Socket.IO
 * `emitToRestaurant` helper (a `low_stock_alert` event).
 *
 * Conventions follow existing FlowUp models (String restaurantId, ObjectId
 * refs, uppercase enums, timestamps).
 */

const notificationSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    type: {
      type: String,
      enum: ["LOW_STOCK"],
      required: true,
      index: true,
    },

    // Relation to the raw material for LOW_STOCK (null for other future types).
    rawMaterialId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RawMaterial",
      default: null,
      index: true,
    },

    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },

    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },

    read: {
      type: Boolean,
      default: false,
      index: true,
    },

    // Safe, non-secret metadata for the UI (quantities/unit at alert time).
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true, // createdAt / updatedAt
  }
);

// ── Indexes ────────────────────────────────────────────────────────
// (1) List a restaurant's notifications, newest first (feed + refresh hydrate).
notificationSchema.index({ restaurantId: 1, createdAt: -1 });

// (2) Unread filtering per restaurant + type (badge / ?read=false&type=LOW_STOCK).
notificationSchema.index({ restaurantId: 1, type: 1, read: 1, createdAt: -1 });

module.exports =
  mongoose.models.Notification ||
  mongoose.model("Notification", notificationSchema);
