const mongoose = require("mongoose");

/**
 * PaymentIntent — stores validated order data server-side BEFORE
 * the customer pays via Razorpay. This ensures:
 * 1. Prices are server-validated (not trusted from frontend)
 * 2. If browser closes after payment, webhook can reconstruct the order
 * 3. Race conditions between frontend verification and webhook are handled atomically
 *
 * State Machine:
 *   CREATED → PAID → ORDER_CREATED
 *                  ↘ FAILED
 *   CREATED → EXPIRED
 *   ORDER_CREATED → REFUNDED
 */

const paymentIntentItemSchema = new mongoose.Schema({
  menuId:   { type: mongoose.Schema.Types.ObjectId, ref: "Menu", required: true },
  name:     { type: String, required: true },
  image:    { type: String, default: "" },
  price:    { type: Number, required: true, min: 0 },
  quantity: { type: Number, required: true, min: 1 },
  subtotal: { type: Number, required: true, min: 0 },
  itemNote: { type: String, default: "" },
}, { _id: false });

const paymentIntentSchema = new mongoose.Schema({
  restaurantId: {
    type: String,
    required: true,
    index: true,
  },

  // ── Payment state ──────────────────────────────────────────────
  status: {
    type: String,
    enum: ["CREATED", "PAID", "ORDER_CREATED", "FAILED", "EXPIRED", "REFUNDED"],
    default: "CREATED",
    index: true,
  },

  // ── Razorpay references ────────────────────────────────────────
  razorpayOrderId: {
    type: String,
    required: true,
    unique: true,
  },

  razorpayPaymentId: {
    type: String,
    default: null,
    sparse: true,
  },

  // ── Idempotency ────────────────────────────────────────────────
  idempotencyKey: {
    type: String,
    default: null,
  },

  // ── Order intent (validated server-side snapshot) ───────────────
  orderType: {
    type: String,
    enum: ["DELIVERY"],
    required: true,
  },

  customer: {
    name:    { type: String, required: true },
    mobile:  { type: String, required: true },
    address: { type: String, default: "" },
  },

  items: {
    type: [paymentIntentItemSchema],
    required: true,
  },

  totalItems: { type: Number, required: true, min: 1 },
  subtotalAmount: { type: Number, required: true, min: 0 },
  deliveryCharge: { type: Number, default: 0, min: 0 },
  totalAmount: { type: Number, required: true, min: 0 },
  note: { type: String, default: "" },
  address: { type: String, default: "" },

  deliveryLocation: {
    latitude:  { type: Number, min: -90, max: 90 },
    longitude: { type: Number, min: -180, max: 180 },
  },

  // ── Result ─────────────────────────────────────────────────────
  // The FlowUp Order created after successful payment
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Order",
    default: null,
  },

  // ── Expiry ─────────────────────────────────────────────────────
  expiresAt: {
    type: Date,
    required: true,
    index: true,
  },
}, {
  timestamps: true,
});

// Compound index for idempotency lookup
paymentIntentSchema.index(
  { restaurantId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }
);

module.exports =
  mongoose.models.PaymentIntent || mongoose.model("PaymentIntent", paymentIntentSchema);
