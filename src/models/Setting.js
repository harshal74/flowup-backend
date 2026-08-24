const mongoose = require("mongoose");

const settingSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    restaurantName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    restaurantLogo: {
      type: String,
      default: "",
    },

    restaurantDescription: {
      type: String,
      default: "",
      maxlength: 500,
    },

    whatsappNumber: {
      type: String,
      required: true,
      trim: true,
    },

    contactNumber: {
      type: String,
      default: "",
      trim: true,
    },

    email: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },

    address: {
      type: String,
      default: "",
      trim: true,
    },

    shopOpen: {
      type: Boolean,
      default: true,
      index: true,
    },

    deliveryCharge: {
      type: Number,
      default: 0,
      min: 0,
    },

    minimumOrderAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    averagePreparationTime: {
      type: Number,
      default: 20,
      min: 1,
    },

    openingTime: {
      type: String,
      default: "09:00",
    },

    closingTime: {
      type: String,
      default: "23:00",
    },

    currency: {
      type: String,
      default: "INR",
    },

    feedbackEnabled: {
      type: Boolean,
      default: true,
    },

    whatsappNotificationsEnabled: {
      type: Boolean,
      default: true,
    },

    upiId: {
      type: String,
      default: "",
      trim: true,
    },

    // Dynamic table configuration
    totalTables: {
      type: Number,
      default: 10,
      min: 1,
      max: 200,
    },

    // Delivery payment policy
    deliveryPaymentMode: {
      type: String,
      enum: ["COD", "PAYMENT_FIRST", "BOTH"],
      default: "COD",
    },

    // Public URL slug (e.g., "abc-cafe" → /restaurant/abc-cafe)
    // Managed exclusively by SUPER_ADMIN. Not changeable by restaurant Admin.
    restaurantSlug: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
      index: true,
    },

    // Platform account status (managed by SUPER_ADMIN only)
    // ACTIVE = restaurant operates normally
    // SUSPENDED = all operations blocked for this restaurant
    accountStatus: {
      type: String,
      enum: ["ACTIVE", "SUSPENDED"],
      default: "ACTIVE",
      index: true,
    },

    suspendedAt: {
      type: Date,
      default: null,
    },

    suspendedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },

    suspensionReason: {
      type: String,
      default: null,
      trim: true,
      maxlength: 500,
    },
  },
  {
    timestamps: true,
  }
);

module.exports =
  mongoose.models.Setting ||
  mongoose.model("Setting", settingSchema);