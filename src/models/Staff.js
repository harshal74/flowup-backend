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

    // Lifecycle status: PENDING → ACTIVE | REJECTED; ACTIVE ↔ BLOCKED
    status: {
      type: String,
      enum: ["PENDING", "ACTIVE", "REJECTED", "BLOCKED"],
      default: "PENDING",
    },

    isActive: {
      type: Boolean,
      default: false,
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

    // Admin approval fields
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },

    reviewedAt: {
      type: Date,
      default: null,
    },

    rejectionReason: {
      type: String,
      default: null,
      trim: true,
      maxlength: 500,
    },

    // Legacy field — kept for backward compatibility with existing accounts
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

staffSchema.index({ restaurantId: 1, email: 1 });
staffSchema.index({ restaurantId: 1, status: 1 });

module.exports =
  mongoose.models.Staff || mongoose.model("Staff", staffSchema);
