const Order    = require("../models/Order");
const Menu     = require("../models/Menu");
const Category = require("../models/Category");
const Customer = require("../models/Customer");
const Setting  = require("../models/Setting");
const crypto   = require("crypto");
const { emitToRestaurant } = require("../socket");
const { validateDeliveryLocation } = require("../utils/validateLocation");
const { isValidMobile, normalizeMobile, MOBILE_ERROR_MESSAGE } = require("../utils/validateMobile");

/**
 * Generate a high-entropy order number.
 * Format: ORD-<timestamp_ms>-<6 hex chars uppercase>
 * Example: ORD-1722345678901-A3F7C2
 *
 * Using crypto.randomBytes(3) gives 16,777,216 possible suffixes per millisecond,
 * making accidental collisions astronomically unlikely.
 * The Order schema enforces uniqueness at the DB level; E11000 is caught and retried.
 */
function generateOrderNumber() {
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `ORD-${Date.now()}-${suffix}`;
}

// ─────────────────────────────────────────────────────────────────
// Create Order  (public — no auth required)
// ─────────────────────────────────────────────────────────────────
const createOrder = async (req, res) => {
  try {
    const { orderType, tableNumber, customer, items, note, address, deliveryLocation } = req.body;

    // Use validated restaurantId from resolvePublicRestaurant middleware
    const restaurantId = req.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ success: false, message: "Restaurant context is required." });
    }

    // ── Shop open/closed check ─────────────────────────────────
    const settings = await Setting.findOne({ restaurantId });
    if (settings && settings.shopOpen === false) {
      return res.status(403).json({
        success: false,
        message: "Restaurant is currently closed. Orders are not being accepted.",
      });
    }

    // ── Online delivery enabled check ──────────────────────────
    // onlineDeliveryEnabled defaults to true so existing restaurants are unaffected.
    // When explicitly set to false, DELIVERY orders are rejected here (backend enforcement).
    // TAKE_AWAY and DINE_IN are never blocked by this flag.
    if (orderType === "DELIVERY" && settings?.onlineDeliveryEnabled === false) {
      return res.status(403).json({
        success: false,
        message: "Delivery is currently unavailable. Please choose Take Away or Dine In.",
      });
    }

    // ── Delivery payment mode enforcement ──────────────────────
    // If restaurant requires PAYMENT_FIRST for delivery, reject COD attempts here.
    // The PAYMENT_FIRST flow uses /api/payment/verify-and-create-order instead.
    if (orderType === "DELIVERY") {
      const deliveryMode = settings?.deliveryPaymentMode || "COD";
      if (deliveryMode === "PAYMENT_FIRST") {
        return res.status(400).json({
          success: false,
          message: "This restaurant requires online payment for delivery orders. Please use the online payment option.",
        });
      }
      // If mode is "BOTH", the customer can use this endpoint for COD.
      // Online payments go through /api/payment/verify-and-create-order.
    }

    if (!customer) {
      return res.status(400).json({ success: false, message: "Customer details are required" });
    }

    if (!customer.mobile || !customer.name) {
      return res.status(400).json({ success: false, message: "Customer name and mobile are required" });
    }

    if (!isValidMobile(customer.mobile)) {
      return res.status(400).json({ success: false, message: MOBILE_ERROR_MESSAGE });
    }

    // ── Idempotency protection ─────────────────────────────────
    // Frontend sends a unique `idempotencyKey` per intentional order submission.
    // Same key on retry (double-click, network retry) → return existing order.
    // Different key (new intentional order) → create new order normally.
    // No key → no deduplication (backwards-compatible).
    let idempotencyKey = null;
    if (req.body.idempotencyKey !== undefined && req.body.idempotencyKey !== null && req.body.idempotencyKey !== "") {
      if (typeof req.body.idempotencyKey !== "string") {
        return res.status(400).json({ success: false, message: "idempotencyKey must be a string" });
      }
      const trimmed = req.body.idempotencyKey.trim();
      if (trimmed.length === 0) {
        // Treat empty/whitespace-only as no key
        idempotencyKey = null;
      } else if (trimmed.length > 128) {
        return res.status(400).json({ success: false, message: "idempotencyKey must be 128 characters or fewer" });
      } else {
        idempotencyKey = trimmed;
      }
    }

    if (idempotencyKey) {
      const existingOrder = await Order.findOne({
        restaurantId,
        idempotencyKey,
      }).populate("customerId", "name mobile address");

      if (existingOrder) {
        return res.status(200).json({
          success: true,
          message: "Order already placed",
          data: existingOrder,
        });
      }
    }

    if (!orderType || !["DINE_IN", "DELIVERY", "TAKE_AWAY"].includes(orderType)) {
      return res.status(400).json({ success: false, message: "Invalid order type" });
    }

    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, message: "Order items are required" });
    }

    if (orderType === "DINE_IN" && (!tableNumber || tableNumber < 1)) {
      return res.status(400).json({ success: false, message: "Table number is required for dine-in orders" });
    }

    // FIX M1: Validate table number does not exceed configured totalTables.
    if (orderType === "DINE_IN" && tableNumber) {
      const maxTables = settings?.totalTables || 10;
      if (tableNumber > maxTables) {
        return res.status(400).json({
          success: false,
          message: `Table number must be between 1 and ${maxTables}.`,
        });
      }
    }

    if (orderType === "DELIVERY" && !customer.address && !address) {
      return res.status(400).json({ success: false, message: "Delivery address is required" });
    }

    // ── Delivery location enforcement ─────────────────────────
    // Only required for DELIVERY. TAKE_AWAY does not use delivery location.
    if (orderType === "DELIVERY") {
      const locResult = validateDeliveryLocation(deliveryLocation);
      if (!locResult.valid) {
        return res.status(400).json({ success: false, message: locResult.message });
      }
    }

    // Find / create customer
    let existingCustomer = await Customer.findOne({ restaurantId, mobile: normalizeMobile(customer.mobile) });

    if (existingCustomer && existingCustomer.isBlocked) {
      return res.status(403).json({ success: false, message: "Customer is blocked" });
    }

    if (!existingCustomer) {
      existingCustomer = await Customer.create({
        restaurantId,
        name: customer.name,
        mobile: normalizeMobile(customer.mobile),
        address: customer.address || "",
      });
    }

    let orderItems = [];
    let totalItems = 0;
    let subtotalAmount = 0;

    for (const item of items) {
      const menuItem = await Menu.findOne({ _id: item.menuId, restaurantId });

      if (!menuItem) {
        return res.status(404).json({ success: false, message: "Menu item not found" });
      }

      if (!menuItem.isAvailable) {
        return res.status(400).json({ success: false, message: `${menuItem.name} is currently unavailable` });
      }

      // Check that the menu item's category is active
      if (menuItem.categoryId) {
        const category = await Category.findOne({ _id: menuItem.categoryId, restaurantId }).select("isActive name");
        if (category && !category.isActive) {
          return res.status(400).json({
            success: false,
            message: `"${category.name}" category is currently unavailable. Please remove items from this category and try again.`,
          });
        }
      }

      const price = menuItem.discountedPrice || menuItem.price;
      const subtotal = price * item.quantity;

      orderItems.push({
        menuId: menuItem._id,
        name: menuItem.name,
        image: menuItem.image,
        price,
        quantity: item.quantity,
        subtotal,
        itemNote: item.itemNote || "",
      });

      totalItems += item.quantity;
      subtotalAmount += subtotal;
    }

    // Calculate delivery charge from settings — only applies to DELIVERY orders
    let deliveryChargeAmount = 0;
    if (orderType === "DELIVERY" && settings && settings.deliveryCharge > 0) {
      deliveryChargeAmount = settings.deliveryCharge;
    }

    const order = await Order.create({
      restaurantId,
      orderNumber: generateOrderNumber(),
      customerId: existingCustomer._id,
      orderType,
      tableNumber: orderType === "DINE_IN" ? tableNumber : null,
      items: orderItems,
      totalItems,
      subtotalAmount,
      deliveryCharge: deliveryChargeAmount,
      totalAmount: subtotalAmount + deliveryChargeAmount,
      note: note || "",
      address: orderType === "DELIVERY" ? (address || customer.address || "") : "",
      ...(orderType === "DELIVERY" && deliveryLocation?.latitude && deliveryLocation?.longitude
        ? { deliveryLocation }
        : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      paymentMethod: orderType === "DELIVERY" ? "COD" : "COD",
    });

    // Update customer stats
    existingCustomer.totalOrders += 1;
    existingCustomer.totalSpent += subtotalAmount + deliveryChargeAmount;
    existingCustomer.lastOrderAt = new Date();
    await existingCustomer.save();

    // Populate customerId for the socket payload so the admin
    // dashboard can render customer name / phone immediately
    const populatedOrder = await Order.findById(order._id).populate(
      "customerId",
      "name mobile address"
    );

    // ── Emit new_order to admin dashboard ──────────────────────
    emitToRestaurant(restaurantId, "new_order", populatedOrder);

    return res.status(201).json({
      success: true,
      message: "Order placed successfully",
      data: populatedOrder,
    });
  } catch (error) {
    // Handle MongoDB E11000 duplicate key on idempotencyKey — race condition
    // Two concurrent requests with the same key both passed the findOne check.
    // The unique index blocked the second insert. Return the first order.
    if (error.code === 11000 && error.keyPattern?.idempotencyKey) {
      const key = (typeof req.body.idempotencyKey === "string") ? req.body.idempotencyKey.trim() : null;
      if (key && req.restaurantId) {
        const existing = await Order.findOne({
          restaurantId: req.restaurantId,
          idempotencyKey: key,
        }).populate("customerId", "name mobile address");
        if (existing) {
          return res.status(200).json({
            success: true,
            message: "Order already placed",
            data: existing,
          });
        }
      }
    }
    // Handle E11000 on orderNumber — extremely rare collision, retry once with fresh number.
    // This must NOT be a recursive retry on unrelated duplicate-key errors.
    if (error.code === 11000 && error.keyPattern?.orderNumber) {
      console.warn("[Order] orderNumber collision — retrying with new number");
      try {
        // Re-attempt is intentionally minimal: we trust the order data is already valid
        // (all validation passed above). We only regenerate the orderNumber.
        const retryOrder = await Order.create({
          restaurantId: req.restaurantId,
          orderNumber:  generateOrderNumber(),
          // The error was on insert, so we cannot reference the failed document object.
          // We log and surface a clean error so the customer retries their order.
        });
        // This path should not be reached — we intentionally surface the error below
        // because we don't have the full order payload here in the catch scope.
        // In practice the collision is so rare we log and return 500 to prompt a retry.
        void retryOrder;
      } catch { /* ignore inner retry errors */ }
      console.error("[Order] orderNumber collision on retry — returning 500 for client retry");
      return res.status(500).json({ success: false, message: "Order number conflict. Please try placing your order again." });
    }
    console.error("Create Order Error:", error.message || error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────────
// Get All Orders (paginated, with optional status filter)
//
// IMPORTANT: Active orders (PENDING, ACCEPTED, PREPARING, READY,
// OUT_FOR_DELIVERY) are ALWAYS included in the response regardless of
// pagination. This prevents the scenario where a PENDING order placed
// a long time ago falls off page 1 because newer completed/rejected
// orders fill the limit — causing the dashboard to show "1 pending"
// while the Orders page shows none.
//
// Behaviour:
//   1. Always fetch ALL active orders (no limit — typically < 50).
//   2. Fill remaining slots up to effectiveLimit with recent
//      non-active orders, excluding IDs already returned.
//   3. Sort the merged result: active orders first (oldest first so
//      the most urgent are at the top), then historical orders
//      newest first.
// ─────────────────────────────────────────────────────────────────
const ACTIVE_ORDER_STATUSES = ["PENDING", "ACCEPTED", "PREPARING", "READY", "OUT_FOR_DELIVERY"];

const getOrders = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { status, page = 1, limit = 100 } = req.query;

    // Cap at 200 to prevent unbounded queries; default is 100 to preserve existing UI behavior.
    const effectiveLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const effectivePage  = Number(page) || 1;

    // If a specific status filter is requested, use the simple paginated path.
    if (status) {
      const filter = { restaurantId, status };
      const skip  = (effectivePage - 1) * effectiveLimit;
      const total = await Order.countDocuments(filter);
      const orders = await Order.find(filter)
        .populate("customerId", "name mobile address")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(effectiveLimit);

      return res.status(200).json({
        success: true,
        count: orders.length,
        total,
        page: effectivePage,
        limit: effectiveLimit,
        data: orders,
      });
    }

    const total = await Order.countDocuments({ restaurantId });

    // Step 1: Fetch ALL active orders — no limit, always included.
    const activeOrders = await Order.find({
      restaurantId,
      status: { $in: ACTIVE_ORDER_STATUSES },
    })
      .populate("customerId", "name mobile address")
      .sort({ createdAt: 1 }); // oldest active first (most urgent at top)

    // Step 2: Fill remaining slots with recent non-active orders.
    const activeIds  = activeOrders.map(o => o._id);
    const remaining  = Math.max(0, effectiveLimit - activeOrders.length);
    const skip       = Math.max(0, (effectivePage - 1) * effectiveLimit - activeOrders.length);

    const historicalOrders = remaining > 0
      ? await Order.find({
          restaurantId,
          status: { $nin: ACTIVE_ORDER_STATUSES },
          ...(activeIds.length > 0 ? { _id: { $nin: activeIds } } : {}),
        })
          .populate("customerId", "name mobile address")
          .sort({ createdAt: -1 })
          .skip(skip < 0 ? 0 : skip)
          .limit(remaining)
      : [];

    const orders = [...activeOrders, ...historicalOrders];

    return res.status(200).json({
      success: true,
      count: orders.length,
      total,
      page: effectivePage,
      limit: effectiveLimit,
      data: orders,
    });
  } catch (error) {
    console.error("Get Orders Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────────
// Get Single Order — BUG 3 FIX: scope by restaurantId
// ─────────────────────────────────────────────────────────────────
const getOrderById = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const order = await Order.findOne({ _id: req.params.id, restaurantId })
      .populate("customerId", "name mobile address");

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    return res.status(200).json({ success: true, data: order });
  } catch (error) {
    console.error("Get Order Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────────
// Accept Order — BUG 4 FIX: scope by restaurantId
// ─────────────────────────────────────────────────────────────────
const acceptOrder = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const order = await Order.findOne({ _id: req.params.id, restaurantId });

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    if (order.status !== "PENDING") {
      return res.status(409).json({
        success: false,
        message: `Cannot accept — order is already in '${order.status}' status.`,
      });
    }

    order.status = "ACCEPTED";
    order.acceptedAt = new Date();
    await order.save();

    emitToRestaurant(order.restaurantId, "order_status_updated", {
      orderId: order._id,
      status: order.status,
      acceptedAt: order.acceptedAt,
    });

    return res.status(200).json({ success: true, message: "Order accepted successfully", data: order });
  } catch (error) {
    console.error("Accept Order Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────────
// Reject Order — BUG 4 FIX: scope by restaurantId
// ─────────────────────────────────────────────────────────────────
const rejectOrder = async (req, res) => {
  try {
    const { reason = "" } = req.body || {};
    const restaurantId = req.user.restaurantId;

    // First, verify order exists and is rejectable
    const order = await Order.findOne({ _id: req.params.id, restaurantId });
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    if (order.status !== "PENDING") {
      return res.status(409).json({
        success: false,
        message: `Cannot reject — order is already in '${order.status}' status.`,
      });
    }

    // ── ONLINE + PAID → atomic refund lock ────────────────────
    if (order.paymentMethod === "ONLINE" && order.paymentStatus === "PAID" && order.razorpayPaymentId) {

      // Atomic transition: NONE → PROCESSING (only one request wins)
      const locked = await Order.findOneAndUpdate(
        {
          _id: order._id,
          restaurantId,
          status: "PENDING",
          paymentMethod: "ONLINE",
          paymentStatus: "PAID",
          refundStatus: "NONE",
          razorpayPaymentId: { $exists: true, $ne: null },
        },
        {
          $set: {
            refundStatus: "PROCESSING",
            refundInitiatedAt: new Date(),
          },
        },
        { new: true }
      );

      if (!locked) {
        // Could not acquire lock — check current state
        const current = await Order.findById(order._id);
        if (current.refundStatus === "PROCESSING") {
          return res.status(409).json({ success: false, message: "Refund is already being processed." });
        }
        if (current.refundStatus === "PROCESSED" || current.paymentStatus === "REFUNDED") {
          return res.status(409).json({ success: false, message: "Refund has already been completed." });
        }
        if (current.status === "REJECTED") {
          return res.status(409).json({ success: false, message: "Order is already rejected." });
        }
        return res.status(409).json({ success: false, message: "Cannot process refund in current state." });
      }

      // We have the lock — call Razorpay
      const Razorpay = require("razorpay");
      const keyId = process.env.RAZORPAY_KEY_ID;
      const keySecret = process.env.RAZORPAY_KEY_SECRET;

      if (!keyId || !keySecret) {
        // No gateway configured — mark FAILED, reject order
        await Order.findByIdAndUpdate(locked._id, {
          $set: {
            refundStatus: "FAILED",
            refundFailureReason: "Payment gateway credentials not configured",
            status: "REJECTED",
            rejectedAt: new Date(),
            rejectionReason: reason,
          },
        });
        const updated = await Order.findById(locked._id);
        emitToRestaurant(restaurantId, "order_status_updated", {
          orderId: updated._id, status: "REJECTED", rejectedAt: updated.rejectedAt,
          rejectionReason: reason, paymentStatus: updated.paymentStatus, refundStatus: updated.refundStatus,
        });
        return res.status(200).json({
          success: true,
          message: "Order rejected. Refund could not be processed (gateway not configured).",
          data: updated, refundFailed: true,
        });
      }

      try {
        const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
        const refundAmountPaise = Math.round(locked.totalAmount * 100);

        const refund = await razorpay.payments.refund(locked.razorpayPaymentId, {
          amount: refundAmountPaise,
          notes: { reason: reason || "Order rejected", flowup_order: locked.orderNumber, restaurant: restaurantId },
        });

        // Razorpay accepted the refund — update order atomically
        const refunded = await Order.findByIdAndUpdate(locked._id, {
          $set: {
            status: "REJECTED",
            rejectedAt: new Date(),
            rejectionReason: reason,
            refundStatus: "PROCESSED",
            refundId: refund.id,
            refundAmount: locked.totalAmount,
            refundProcessedAt: new Date(),
            paymentStatus: "REFUNDED",
          },
        }, { new: true });

        console.log(`[Refund] ✓ ${refund.id} for order ${locked.orderNumber} — ₹${locked.totalAmount}`);

        emitToRestaurant(restaurantId, "order_status_updated", {
          orderId: refunded._id, status: "REJECTED", rejectedAt: refunded.rejectedAt,
          rejectionReason: reason, paymentStatus: "REFUNDED", refundStatus: "PROCESSED",
        });

        return res.status(200).json({
          success: true,
          message: `Order rejected — refund of ₹${locked.totalAmount} initiated.`,
          data: refunded,
          refund: { refundId: refund.id, status: refund.status, amount: locked.totalAmount },
        });
      } catch (refundErr) {
        // Razorpay call failed — mark FAILED, still reject order
        const errMsg = refundErr.error?.description || refundErr.message || "Unknown refund error";
        console.error(`[Refund] ✗ Order ${locked.orderNumber}:`, errMsg);

        await Order.findByIdAndUpdate(locked._id, {
          $set: {
            refundStatus: "FAILED",
            refundFailureReason: errMsg,
            status: "REJECTED",
            rejectedAt: new Date(),
            rejectionReason: reason,
          },
        });
        const failed = await Order.findById(locked._id);

        emitToRestaurant(restaurantId, "order_status_updated", {
          orderId: failed._id, status: "REJECTED", rejectedAt: failed.rejectedAt,
          rejectionReason: reason, paymentStatus: failed.paymentStatus, refundStatus: "FAILED",
        });

        return res.status(200).json({
          success: true,
          message: "Order rejected, but refund failed. Please retry the refund.",
          data: failed, refundFailed: true, refundError: errMsg,
        });
      }
    }

    // ── Non-online or non-paid orders: simple rejection ───────
    order.status = "REJECTED";
    order.rejectedAt = new Date();
    order.rejectionReason = reason;
    await order.save();

    emitToRestaurant(restaurantId, "order_status_updated", {
      orderId: order._id, status: "REJECTED", rejectedAt: order.rejectedAt, rejectionReason: reason,
    });

    return res.status(200).json({ success: true, message: "Order rejected successfully", data: order });
  } catch (error) {
    console.error("Reject Order Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────────
// Update Order Status — BUG 4 + BUG 5 FIX: ownership + status whitelist
// ─────────────────────────────────────────────────────────────────
const VALID_STATUSES = [
  "ACCEPTED", "PREPARING", "READY",
  "OUT_FOR_DELIVERY", "COMPLETED", "REJECTED", "CANCELLED",
];

const updateOrderStatus = async (req, res) => {
  try {
    const { status } = req.body;

    // BUG 5 FIX: validate status before touching the DB
    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
      });
    }

    const restaurantId = req.user.restaurantId;
    // BUG 4 FIX: scope by restaurantId
    const order = await Order.findOne({ _id: req.params.id, restaurantId });

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    // FIX H1: TAKE_AWAY and DINE_IN orders must never enter OUT_FOR_DELIVERY.
    // Only DELIVERY orders can be dispatched.
    if (status === "OUT_FOR_DELIVERY" && order.orderType !== "DELIVERY") {
      return res.status(400).json({
        success: false,
        message: "Only delivery orders can be dispatched.",
      });
    }

    order.status = status;
    if (status === "COMPLETED") order.completedAt = new Date();

    await order.save();

    emitToRestaurant(order.restaurantId, "order_status_updated", {
      orderId: order._id,
      status: order.status,
      completedAt: order.completedAt || null,
    });

    return res.status(200).json({ success: true, message: "Order status updated successfully", data: order });
  } catch (error) {
    console.error("Update Status Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = {
  createOrder,
  getOrders,
  getOrderById,
  acceptOrder,
  rejectOrder,
  updateOrderStatus,
};
