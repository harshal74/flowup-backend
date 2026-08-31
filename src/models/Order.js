const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema(
  {
    menuId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Menu",
      required: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    image: {
      type: String,
      default: "",
    },

    price: {
      type: Number,
      required: true,
      min: 0,
    },

    quantity: {
      type: Number,
      required: true,
      min: 1,
    },

    subtotal: {
      type: Number,
      required: true,
      min: 0,
    },

    itemNote: {
      type: String,
      default: "",
      maxlength: 200,
      trim: true,
    },
  },
  {
    _id: false,
  },
);

const orderSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: String,
      required: true,
      trim: true,
    },

    orderNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },

    orderType: {
      type: String,
      enum: ["DINE_IN", "DELIVERY", "TAKE_AWAY"],
      required: true,
    },

    tableNumber: {
      type: Number,
      min: 1,
      default: null,
    },

    items: {
      type: [orderItemSchema],
      required: true,
      validate: {
        validator: (items) => items.length > 0,
        message: "Order must contain at least one item",
      },
    },

    totalItems: {
      type: Number,
      required: true,
      min: 1,
    },

    subtotalAmount: {
      type: Number,
      required: true,
      min: 0,
    },

    deliveryCharge: {
      type: Number,
      default: 0,
      min: 0,
    },

    taxAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    discountAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },

    note: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },

    address: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },

    // Optional GPS coordinates for delivery orders (set by customer frontend)
    deliveryLocation: {
      latitude:  { type: Number, min: -90,  max: 90  },
      longitude: { type: Number, min: -180, max: 180 },
    },

    billId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Bill",
      default: null,
    },

    status: {
      type: String,
      enum: [
        "PENDING",
        "ACCEPTED",
        "PREPARING",
        "READY",
        "OUT_FOR_DELIVERY",
        "COMPLETED",
        "REJECTED",
        "CANCELLED",
      ],
      default: "PENDING",
    },

    paymentStatus: {
      type: String,
      enum: ["PENDING", "PAID", "FAILED", "REFUNDED"],
      default: "PENDING",
    },

    paymentMethod: {
      type: String,
      enum: ["COD", "ONLINE"],
      default: "COD",
    },

    // Razorpay payment references (online payments only)
    razorpayOrderId: {
      type: String,
      default: null,
    },

    razorpayPaymentId: {
      type: String,
      default: null,
    },

    // Refund tracking
    refundStatus: {
      type: String,
      enum: ["NONE", "PENDING", "PROCESSING", "PROCESSED", "FAILED"],
      default: "NONE",
    },

    refundId: {
      type: String,
      default: null,
    },

    refundAmount: {
      type: Number,
      default: null,
    },

    refundInitiatedAt: {
      type: Date,
      default: null,
    },

    refundProcessedAt: {
      type: Date,
      default: null,
    },

    refundFailureReason: {
      type: String,
      default: null,
    },

    estimatedTime: {
      type: Number,
      default: null,
    },

    feedbackSubmitted: {
      type: Boolean,
      default: false,
    },

    acceptedAt: {
      type: Date,
      default: null,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    rejectedAt: {
      type: Date,
      default: null,
    },

    cancellationReason: {
      type: String,
      default: "",
      trim: true,
    },

    rejectionReason: {
      type: String,
      default: "",
      trim: true,
    },

    // Staff references — populated by the waiter app
    acceptedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },

    // Client-generated idempotency key for duplicate prevention.
    // Compound unique index with restaurantId prevents duplicate orders
    // from double-clicks, network retries, or browser replays.
    idempotencyKey: {
      type: String,
      default: null,
      trim: true,
      maxlength: 128,
    },

    preparedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },

    servedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// Indexes
orderSchema.index({
  restaurantId: 1,
  createdAt: -1,
});

orderSchema.index({
  restaurantId: 1,
  status: 1,
});

orderSchema.index({
  customerId: 1,
});

// Billing query: completed + unpaid + no bill
orderSchema.index({
  restaurantId: 1,
  status: 1,
  paymentStatus: 1,
  billId: 1,
});

// Idempotency: unique compound index ensures no duplicate orders per key.
// partialFilterExpression excludes documents where idempotencyKey is null,
// so orders without a key (legacy/admin-created) are not affected.
orderSchema.index(
  { restaurantId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }
);

// Razorpay payment lookup — used by webhook reconciliation and duplicate prevention
orderSchema.index(
  { razorpayPaymentId: 1 },
  { sparse: true }
);

module.exports = mongoose.models.Order || mongoose.model("Order", orderSchema);
