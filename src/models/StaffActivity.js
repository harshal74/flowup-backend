const mongoose = require("mongoose");

const staffActivitySchema = new mongoose.Schema(
  {
    restaurantId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    staffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },

    staffName: {
      type: String,
      default: "",
    },

    role: {
      type: String,
      default: "",
    },

    action: {
      type: String,
      required: true,
      trim: true,
    },

    entityType: {
      type: String,
      trim: true,
      default: "",
    },

    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    oldValue: {
      type: String,
      default: "",
    },

    newValue: {
      type: String,
      default: "",
    },

    ipAddress: {
      type: String,
      default: "",
    },

    userAgent: {
      type: String,
      default: "",
    },

    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: false }
);

staffActivitySchema.index({ restaurantId: 1, timestamp: -1 });
staffActivitySchema.index({ staffId: 1 });

module.exports =
  mongoose.models.StaffActivity ||
  mongoose.model("StaffActivity", staffActivitySchema);
