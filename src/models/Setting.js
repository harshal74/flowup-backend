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

    // GST configuration
    // Default: gstEnabled = false so existing restaurants are NOT affected by the new fields.
    // An existing restaurant with no GST fields stored will use these schema defaults:
    // gstEnabled=false → no GST added to bills (backward-compatible with the old hardcoded 5%
    // which was only on the frontend; backend now reads from DB so safe default is false).
    gstEnabled: {
      type: Boolean,
      default: false,
    },
    sgstRate: {
      type: Number,
      default: 0,
      min: 0,
      max: 50,
    },
    cgstRate: {
      type: Number,
      default: 0,
      min: 0,
      max: 50,
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

    // Subscription expiry date (managed by SUPER_ADMIN only)
    // next calendar day in IST. For example, if the platform admin selects
    // "30 Sep 2026", this field stores:
    //   2026-10-01T00:00:00 IST = 2026-09-30T18:30:00.000Z
    //
    // Access is blocked when:   new Date() >= expiresAt
    // Access is allowed when:   expiresAt is null  OR  new Date() < expiresAt
    //
    // Existing restaurants without this field = null = no expiry (backward-compatible).
    // Do NOT use this field to auto-set accountStatus — expiry is an independent
    // access-control condition separate from manual suspension.
    expiresAt: {
      type: Date,
      default: null,
      index: true,
    },

    // Subscription amount charged by FlowUp to this restaurant (₹/month).
    // PLATFORM PRIVATE DATA — managed by SUPER_ADMIN only.
    // NEVER returned in restaurant-facing, staff, or customer API responses.
    // Default 0 for backward compatibility with existing restaurants.
    subscriptionAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

module.exports =
  mongoose.models.Setting ||
  mongoose.model("Setting", settingSchema);