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
  },
  {
    timestamps: true,
  }
);

module.exports =
  mongoose.models.Setting ||
  mongoose.model("Setting", settingSchema);