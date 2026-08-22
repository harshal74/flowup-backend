/**
 * Payment Controller — Razorpay integration with server-side PaymentIntent.
 *
 * Flow (PAYMENT_FIRST):
 * 1. POST /api/payment/create-order → validates items, stores PaymentIntent, creates Razorpay order
 * 2. Customer pays via Razorpay Checkout
 * 3. EITHER frontend calls POST /api/payment/verify-and-create-order
 *    OR Razorpay webhook calls POST /api/payment/webhook
 *    → whichever arrives first atomically transitions PaymentIntent → creates FlowUp Order
 */

const crypto        = require("crypto");
const Razorpay      = require("razorpay");
const mongoose      = require("mongoose");
const Order         = require("../models/Order");
const PaymentIntent = require("../models/PaymentIntent");
const Menu          = require("../models/Menu");
const Category      = require("../models/Category");
const Customer      = require("../models/Customer");
const Setting       = require("../models/Setting");
const { emitToRestaurant } = require("../socket");
const { restaurantId: DEFAULT_RESTAURANT_ID } = require("../config/env");

const INTENT_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

// ── Razorpay instance (lazy) ─────────────────────────────────────
let razorpayInstance = null;
function getRazorpay() {
  if (!razorpayInstance) {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) return null;
    razorpayInstance = new Razorpay({ key_id: keyId, key_secret: keySecret });
  }
  return razorpayInstance;
}

// ══════════════════════════════════════════════════════════════════
// Shared: Create FlowUp Order from a validated PaymentIntent
// Called by BOTH frontend verification and webhook
// Handles E11000 (duplicate key) gracefully — returns existing order
// ══════════════════════════════════════════════════════════════════
async function createOrderFromIntent(intent) {
  const restaurantId = intent.restaurantId;

  // Check if order already exists for this payment (safety net for retries)
  if (intent.razorpayPaymentId) {
    const existing = await Order.findOne({ razorpayPaymentId: intent.razorpayPaymentId })
      .populate("customerId", "name mobile address");
    if (existing) return existing;
  }

  // Find/create customer
  let customer = await Customer.findOne({ restaurantId, mobile: intent.customer.mobile });
  if (customer && customer.isBlocked) throw new Error("Customer is blocked");
  if (!customer) {
    customer = await Customer.create({
      restaurantId,
      name: intent.customer.name,
      mobile: intent.customer.mobile,
      address: intent.customer.address || "",
    });
  }

  // Create FlowUp Order using the snapshot from PaymentIntent
  let order;
  try {
    order = await Order.create({
      restaurantId,
      orderNumber: `ORD-${Date.now()}-${Math.floor(Math.random() * 9000) + 1000}`,
      customerId: customer._id,
      orderType: "DELIVERY",
      tableNumber: null,
      items: intent.items,
      totalItems: intent.totalItems,
      subtotalAmount: intent.subtotalAmount,
      deliveryCharge: intent.deliveryCharge,
      totalAmount: intent.totalAmount,
      note: intent.note || "",
      address: intent.address || intent.customer.address || "",
      ...(intent.deliveryLocation?.latitude ? { deliveryLocation: intent.deliveryLocation } : {}),
      paymentMethod: "ONLINE",
      paymentStatus: "PAID",
      razorpayOrderId: intent.razorpayOrderId,
      razorpayPaymentId: intent.razorpayPaymentId,
      ...(intent.idempotencyKey ? { idempotencyKey: intent.idempotencyKey } : {}),
    });
  } catch (err) {
    // E11000 on idempotencyKey or razorpayPaymentId — order already exists
    if (err.code === 11000) {
      const existing = await Order.findOne({
        $or: [
          ...(intent.idempotencyKey ? [{ restaurantId, idempotencyKey: intent.idempotencyKey }] : []),
          ...(intent.razorpayPaymentId ? [{ razorpayPaymentId: intent.razorpayPaymentId }] : []),
        ],
      }).populate("customerId", "name mobile address");
      if (existing) return existing;
    }
    throw err;
  }

  // Update customer stats
  customer.totalOrders += 1;
  customer.totalSpent += intent.totalAmount;
  customer.lastOrderAt = new Date();
  await customer.save();

  // Populate for socket emit
  const populated = await Order.findById(order._id).populate("customerId", "name mobile address");

  // Emit new_order
  emitToRestaurant(restaurantId, "new_order", populated);

  return populated;
}

// ══════════════════════════════════════════════════════════════════
// POST /api/payment/create-order
// Validates order, stores PaymentIntent, creates Razorpay order
// ══════════════════════════════════════════════════════════════════
exports.createPaymentOrder = async (req, res) => {
  try {
    const razorpay = getRazorpay();
    if (!razorpay) {
      return res.status(503).json({ success: false, message: "Online payment is not configured." });
    }

    const restaurantId = DEFAULT_RESTAURANT_ID;
    const { orderType, customer, items, note, address, deliveryLocation, idempotencyKey } = req.body;

    // ── Validate request ──────────────────────────────────────
    if (orderType !== "DELIVERY") {
      return res.status(400).json({ success: false, message: "Online payment is only for delivery orders." });
    }
    if (!customer?.name || !customer?.mobile) {
      return res.status(400).json({ success: false, message: "Customer name and mobile are required." });
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "Order items are required." });
    }
    if (!address && !customer.address) {
      return res.status(400).json({ success: false, message: "Delivery address is required." });
    }

    // ── Validate restaurant setting ───────────────────────────
    const settings = await Setting.findOne({ restaurantId });
    if (settings?.shopOpen === false) {
      return res.status(403).json({ success: false, message: "Restaurant is currently closed." });
    }
    const mode = settings?.deliveryPaymentMode || "COD";
    if (mode === "COD") {
      return res.status(400).json({ success: false, message: "This restaurant only accepts Cash on Delivery." });
    }

    // ── Idempotency: check existing intent ────────────────────
    const safeKey = idempotencyKey ? String(idempotencyKey).trim().slice(0, 128) || null : null;
    if (safeKey) {
      const existing = await PaymentIntent.findOne({ restaurantId, idempotencyKey: safeKey, status: { $ne: "EXPIRED" } });
      if (existing) {
        // If order was already created from this intent, return the order
        if (existing.status === "ORDER_CREATED" && existing.orderId) {
          const order = await Order.findById(existing.orderId).populate("customerId", "name mobile address");
          if (order) return res.status(200).json({ success: true, message: "Order already placed", data: order, alreadyPaid: true });
        }
        // Return existing intent's Razorpay order for frontend to reopen checkout
        return res.status(200).json({
          success: true,
          razorpayOrderId: existing.razorpayOrderId,
          amount: existing.totalAmount * 100,
          currency: "INR",
          keyId: process.env.RAZORPAY_KEY_ID,
          intentId: existing._id,
          alreadyPaid: existing.status === "PAID",
        });
      }
    }

    // ── Validate items + calculate amount SERVER-SIDE ──────────
    let orderItems = [];
    let totalItems = 0;
    let subtotalAmount = 0;

    for (const item of items) {
      if (!item.menuId || !item.quantity || item.quantity < 1) {
        return res.status(400).json({ success: false, message: "Invalid item data." });
      }
      const menuItem = await Menu.findOne({ _id: item.menuId, restaurantId });
      if (!menuItem) {
        return res.status(404).json({ success: false, message: `Menu item not found: ${item.menuId}` });
      }
      if (!menuItem.isAvailable) {
        return res.status(400).json({ success: false, message: `${menuItem.name} is currently unavailable.` });
      }
      if (menuItem.categoryId) {
        const cat = await Category.findOne({ _id: menuItem.categoryId, restaurantId }).select("isActive name");
        if (cat && !cat.isActive) {
          return res.status(400).json({ success: false, message: `"${cat.name}" category is unavailable.` });
        }
      }

      const price = menuItem.discountedPrice || menuItem.price;
      const subtotal = price * item.quantity;
      orderItems.push({ menuId: menuItem._id, name: menuItem.name, image: menuItem.image, price, quantity: item.quantity, subtotal, itemNote: item.itemNote || "" });
      totalItems += item.quantity;
      subtotalAmount += subtotal;
    }

    const deliveryCharge = settings?.deliveryCharge > 0 ? settings.deliveryCharge : 0;
    const totalAmount = subtotalAmount + deliveryCharge;
    const amountInPaise = Math.round(totalAmount * 100);

    // ── Create Razorpay Order ─────────────────────────────────
    const rzpOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `flowup_${Date.now()}`,
    });

    // ── Store PaymentIntent ───────────────────────────────────
    const intent = await PaymentIntent.create({
      restaurantId,
      status: "CREATED",
      razorpayOrderId: rzpOrder.id,
      idempotencyKey: safeKey,
      orderType: "DELIVERY",
      customer: { name: customer.name.trim(), mobile: customer.mobile.trim(), address: (address || customer.address || "").trim() },
      items: orderItems,
      totalItems,
      subtotalAmount,
      deliveryCharge,
      totalAmount,
      note: note || "",
      address: (address || customer.address || "").trim(),
      ...(deliveryLocation?.latitude && deliveryLocation?.longitude ? { deliveryLocation } : {}),
      expiresAt: new Date(Date.now() + INTENT_EXPIRY_MS),
    });

    return res.status(201).json({
      success: true,
      razorpayOrderId: rzpOrder.id,
      amount: rzpOrder.amount,
      currency: rzpOrder.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      intentId: intent._id,
    });
  } catch (error) {
    if (error.code === 11000) {
      // Duplicate idempotencyKey — fetch and return existing
      return res.status(200).json({ success: true, message: "Payment intent already exists. Retry with existing Razorpay order." });
    }
    console.error("[Payment] createPaymentOrder error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to create payment order." });
  }
};

// ══════════════════════════════════════════════════════════════════
// POST /api/payment/verify-and-create-order
// Frontend calls after Razorpay Checkout succeeds
// ══════════════════════════════════════════════════════════════════
exports.verifyAndCreateOrder = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: "Payment verification details are required." });
    }

    // ── Verify signature ──────────────────────────────────────
    const expectedSig = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSig !== razorpay_signature) {
      return res.status(400).json({ success: false, message: "Payment verification failed — invalid signature." });
    }

    // ── Atomically transition PaymentIntent: CREATED → PAID → ORDER_CREATED ──
    const intent = await PaymentIntent.findOneAndUpdate(
      { razorpayOrderId: razorpay_order_id, status: { $in: ["CREATED", "PAID"] } },
      { $set: { status: "PAID", razorpayPaymentId: razorpay_payment_id } },
      { new: true }
    );

    if (!intent) {
      // Maybe already ORDER_CREATED by webhook — return existing order
      const completed = await PaymentIntent.findOne({ razorpayOrderId: razorpay_order_id, status: "ORDER_CREATED" });
      if (completed?.orderId) {
        const order = await Order.findById(completed.orderId).populate("customerId", "name mobile address");
        if (order) return res.status(200).json({ success: true, message: "Order already placed", data: order });
      }
      return res.status(400).json({ success: false, message: "Payment intent not found or already processed." });
    }

    // Check expiry (but don't reject — payment was verified)
    // Even if technically expired, a verified payment should proceed.

    // ── Create FlowUp Order (atomic transition to ORDER_CREATED) ──
    const orderResult = await PaymentIntent.findOneAndUpdate(
      { _id: intent._id, status: "PAID" },
      { $set: { status: "ORDER_CREATED" } },
      { new: true }
    );

    if (!orderResult || orderResult.status !== "ORDER_CREATED") {
      // Lost the race to webhook — return existing order
      const existing = await PaymentIntent.findById(intent._id);
      if (existing?.orderId) {
        const order = await Order.findById(existing.orderId).populate("customerId", "name mobile address");
        if (order) return res.status(200).json({ success: true, message: "Order already placed", data: order });
      }
      return res.status(409).json({ success: false, message: "Order already being created." });
    }

    // We won the race — create the order
    let order;
    try {
      order = await createOrderFromIntent(orderResult);
    } catch (createErr) {
      // Order creation failed — revert PaymentIntent to PAID so it can be retried
      // (by webhook or next frontend request)
      await PaymentIntent.findByIdAndUpdate(orderResult._id, { $set: { status: "PAID" } });
      console.error("[Payment] Order creation failed after winning race:", createErr.message);
      return res.status(500).json({ success: false, message: "Order creation failed. Your payment is safe — please retry or contact the restaurant." });
    }

    // Store order reference on intent
    await PaymentIntent.findByIdAndUpdate(orderResult._id, { orderId: order._id });

    return res.status(201).json({
      success: true,
      message: "Payment verified and order placed successfully.",
      data: order,
    });
  } catch (error) {
    console.error("[Payment] verifyAndCreateOrder error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to create order after payment." });
  }
};

// ══════════════════════════════════════════════════════════════════
// POST /api/payment/webhook — Razorpay server-to-server
// ══════════════════════════════════════════════════════════════════
exports.razorpayWebhook = async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) return res.status(200).json({ status: "ok" });

    // ── Verify webhook signature ──────────────────────────────
    const signature = req.headers["x-razorpay-signature"];
    if (!signature) return res.status(400).json({ status: "missing signature" });

    const expected = crypto
      .createHmac("sha256", webhookSecret)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (expected !== signature) {
      console.warn("[Webhook] Invalid signature");
      return res.status(400).json({ status: "invalid signature" });
    }

    const event = req.body.event;
    const payload = req.body.payload;

    // ── payment.captured ──────────────────────────────────────
    if (event === "payment.captured") {
      const payment = payload?.payment?.entity;
      if (!payment) return res.status(200).json({ status: "ok" });

      const razorpayOrderId   = payment.order_id;
      const razorpayPaymentId = payment.id;

      // Atomically transition: CREATED → PAID
      const intent = await PaymentIntent.findOneAndUpdate(
        { razorpayOrderId, status: { $in: ["CREATED", "PAID"] } },
        { $set: { status: "PAID", razorpayPaymentId } },
        { new: true }
      );

      if (!intent) {
        // Already processed or doesn't exist
        return res.status(200).json({ status: "already_processed" });
      }

      // Atomically transition: PAID → ORDER_CREATED
      const transitioned = await PaymentIntent.findOneAndUpdate(
        { _id: intent._id, status: "PAID" },
        { $set: { status: "ORDER_CREATED" } },
        { new: true }
      );

      if (!transitioned || transitioned.status !== "ORDER_CREATED") {
        // Frontend verification won the race — that's fine
        return res.status(200).json({ status: "race_lost_ok" });
      }

      // Create FlowUp Order
      try {
        const order = await createOrderFromIntent(transitioned);
        await PaymentIntent.findByIdAndUpdate(transitioned._id, { orderId: order._id });
        console.log(`[Webhook] ✓ Order ${order.orderNumber} created from webhook for payment ${razorpayPaymentId}`);
      } catch (orderErr) {
        // Revert status so it can be retried
        await PaymentIntent.findByIdAndUpdate(transitioned._id, { $set: { status: "PAID" } });
        console.error(`[Webhook] Order creation failed for payment ${razorpayPaymentId}:`, orderErr.message);
      }
    }

    // ── payment.failed ────────────────────────────────────────
    if (event === "payment.failed") {
      const payment = payload?.payment?.entity;
      if (payment?.order_id) {
        await PaymentIntent.findOneAndUpdate(
          { razorpayOrderId: payment.order_id, status: "CREATED" },
          { $set: { status: "FAILED" } }
        );
      }
    }

    // ── refund events ─────────────────────────────────────────
    if (event === "refund.created" || event === "refund.processed") {
      const refund = payload?.refund?.entity;
      if (refund?.payment_id) {
        const order = await Order.findOne({ razorpayPaymentId: refund.payment_id });
        if (order && order.paymentStatus !== "REFUNDED") {
          order.paymentStatus = "REFUNDED";
          order.refundStatus = "PROCESSED";
          order.refundId = order.refundId || refund.id;
          order.refundAmount = (refund.amount || 0) / 100; // paise → rupees
          order.refundProcessedAt = new Date();
          await order.save();
          console.log(`[Webhook] Refund ${refund.id} confirmed for order ${order.orderNumber}`);
        }
        await PaymentIntent.findOneAndUpdate(
          { razorpayPaymentId: refund.payment_id },
          { $set: { status: "REFUNDED" } }
        );
      }
    }

    return res.status(200).json({ status: "ok" });
  } catch (error) {
    console.error("[Webhook] Error:", error.message);
    return res.status(200).json({ status: "error_logged" });
  }
};

// ══════════════════════════════════════════════════════════════════
// GET /api/payment/config
// ══════════════════════════════════════════════════════════════════
exports.getPaymentConfig = async (req, res) => {
  try {
    const restaurantId = req.query.restaurantId || DEFAULT_RESTAURANT_ID;
    const settings = await Setting.findOne({ restaurantId }).select("deliveryPaymentMode");
    const keyId = process.env.RAZORPAY_KEY_ID || "";
    const mode = settings?.deliveryPaymentMode || "COD";

    return res.status(200).json({
      success: true,
      deliveryPaymentMode: mode,
      razorpayKeyId: mode !== "COD" ? keyId : "",
    });
  } catch (error) {
    console.error("[Payment] getPaymentConfig error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ══════════════════════════════════════════════════════════════════
// POST /api/payment/refund/:orderId — Admin refund
// ══════════════════════════════════════════════════════════════════
exports.refundPayment = async (req, res) => {
  try {
    const razorpay = getRazorpay();
    if (!razorpay) return res.status(503).json({ success: false, message: "Payment gateway not configured." });

    const restaurantId = req.user.restaurantId;
    const { orderId } = req.params;

    // Atomic lock: only transition FAILED → PROCESSING (retry scenario)
    const locked = await Order.findOneAndUpdate(
      {
        _id: orderId,
        restaurantId,
        paymentMethod: "ONLINE",
        paymentStatus: "PAID",
        refundStatus: "FAILED",
        razorpayPaymentId: { $exists: true, $ne: null },
      },
      { $set: { refundStatus: "PROCESSING", refundInitiatedAt: new Date(), refundFailureReason: null } },
      { new: true }
    );

    if (!locked) {
      // Check why lock failed
      const order = await Order.findOne({ _id: orderId, restaurantId });
      if (!order) return res.status(404).json({ success: false, message: "Order not found." });
      if (order.paymentMethod !== "ONLINE") return res.status(400).json({ success: false, message: "Only online-paid orders can be refunded." });
      if (order.refundStatus === "PROCESSED" || order.paymentStatus === "REFUNDED") return res.status(400).json({ success: false, message: "Already refunded." });
      if (order.refundStatus === "PROCESSING") return res.status(409).json({ success: false, message: "Refund is already being processed." });
      if (order.paymentStatus !== "PAID") return res.status(400).json({ success: false, message: "Payment is not in PAID status." });
      return res.status(400).json({ success: false, message: "Refund is not in a retryable state." });
    }

    // We have the lock — call Razorpay
    try {
      const refund = await razorpay.payments.refund(locked.razorpayPaymentId, {
        amount: Math.round(locked.totalAmount * 100),
        notes: { reason: "Admin retry refund", flowup_order: locked.orderNumber, restaurant: restaurantId },
      });

      await Order.findByIdAndUpdate(locked._id, {
        $set: {
          refundStatus: "PROCESSED",
          refundId: refund.id,
          refundAmount: locked.totalAmount,
          refundProcessedAt: new Date(),
          paymentStatus: "REFUNDED",
        },
      });

      console.log(`[Refund Retry] ✓ ${refund.id} for order ${locked.orderNumber}`);
      return res.status(200).json({ success: true, message: `Refund of ₹${locked.totalAmount} processed.`, refundId: refund.id });
    } catch (refundErr) {
      const errMsg = refundErr.error?.description || refundErr.message || "Unknown error";
      await Order.findByIdAndUpdate(locked._id, { $set: { refundStatus: "FAILED", refundFailureReason: errMsg } });
      console.error(`[Refund Retry] ✗ Order ${locked.orderNumber}:`, errMsg);
      return res.status(500).json({ success: false, message: `Refund failed: ${errMsg}` });
    }
  } catch (error) {
    console.error("[Refund] Error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to process refund." });
  }
};
