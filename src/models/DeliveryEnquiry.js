const mongoose = require("mongoose");

const deliveryEnquirySchema = new mongoose.Schema(
  {
    restaurantId: {
      type:     String,
      required: true,
      trim:     true,
      index:    true,
    },

    customerName: {
      type:      String,
      required:  true,
      trim:      true,
      maxlength: 100,
    },

    mobile: {
      type:     String,
      required: true,
      trim:     true,
    },

    email: {
      type:      String,
      trim:      true,
      lowercase: true,
      default:   "",
    },

    address: {
      type:      String,
      trim:      true,
      maxlength: 500,
      default:   "",
    },

    deliveryLocation: {
      latitude:  { type: Number, min: -90,  max: 90  },
      longitude: { type: Number, min: -180, max: 180 },
    },

    message: {
      type:      String,
      trim:      true,
      maxlength: 1000,
      default:   "",
    },

    status: {
      type:    String,
      enum:    ["NEW", "CONTACTED", "RESOLVED", "CLOSED"],
      default: "NEW",
      index:   true,
    },

    // Admin-only internal note
    note: {
      type:      String,
      trim:      true,
      maxlength: 1000,
      default:   "",
    },

    resolvedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     "Admin",
      default: null,
    },

    resolvedAt: {
      type:    Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Efficient per-restaurant queries
deliveryEnquirySchema.index({ restaurantId: 1, createdAt: -1 });
deliveryEnquirySchema.index({ restaurantId: 1, status: 1 });

module.exports =
  mongoose.models.DeliveryEnquiry ||
  mongoose.model("DeliveryEnquiry", deliveryEnquirySchema);
