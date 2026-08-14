const mongoose = require("mongoose");

const staffSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    mobile: {
      type: String,
      required: true,
      trim: true,
    },

    password: {
      type: String,
      required: true,
      select: false,
    },

    role: {
      type: String,
      enum: ["ADMIN", "CHEF", "WAITER", "ASSISTANT"],
      required: true,
    },

    status: {
      type: String,
      default: "active",
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },

    lastLogin: {
      type: Date,
      default: null,
    },

    profileImage: {
      type: String,
      default: "",
    },

    // Email OTP verification
    isEmailVerified: {
      type: Boolean,
      default: false,
    },

    emailOtp: {
      type: String,
      default: null,
      select: false,
    },

    emailOtpExpiry: {
      type: Date,
      default: null,
      select: false,
    },

    emailOtpAttempts: {
      type: Number,
      default: 0,
      select: false,
    },
  },
  { timestamps: true }
);

staffSchema.index({ restaurantId: 1, email: 1 });

module.exports =
  mongoose.models.Staff || mongoose.model("Staff", staffSchema);
