const mongoose = require("mongoose");

const waiterRequestSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    tableNumber: {
      type: Number,
      required: true,
      min: 1,
    },

    customerName: {
      type: String,
      default: "",
      trim: true,
    },

    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },

    status: {
      type: String,
      enum: ["PENDING", "ACCEPTED", "COMPLETED"],
      default: "PENDING",
    },

    // WAITER = "call waiter"; BILL = customer asked for the bill.
    // Legacy records have no value and are treated as WAITER.
    requestType: {
      type: String,
      enum: ["WAITER", "BILL"],
      default: "WAITER",
    },

    // Staff reference — who resolved this request
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

waiterRequestSchema.index({ restaurantId: 1, createdAt: -1 });
waiterRequestSchema.index({ restaurantId: 1, status: 1 });

module.exports =
  mongoose.models.WaiterRequest ||
  mongoose.model("WaiterRequest", waiterRequestSchema);
