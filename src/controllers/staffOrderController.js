const Order                = require("../models/Order");
const Setting              = require("../models/Setting");
const mongoose             = require("mongoose");
const { emitToRestaurant } = require("../socket");
const { logActivity }      = require("../services/staffActivityService");
const {
  sendOrderStatusWhatsApp,
  buildOutForDeliveryMessage,
  buildDeliveredMessage,
} = require("../services/whatsapp.service");

// ── WhatsApp notify helper (Phase 18) — fire-and-forget ──────────
// Sends OUT_FOR_DELIVERY / DELIVERED notifications after a successful staff
// transition. NEVER throws and NEVER blocks the transition response. Passes
// structured templateInput (Phase 9) alongside the Twilio free-text body, so a
// future Meta activation can build the approved template. Loads settings +
// customer with their own queries (this controller does not preload them).
function _notifyStaffTransition(restaurantId, orderId, notifyEvent) {
  if (!notifyEvent) return;
  Setting.findOne({ restaurantId })
    .select("restaurantName whatsappNotificationsEnabled countryCode")
    .lean()
    .then(settings => {
      if (settings?.whatsappNotificationsEnabled === false) return;
      return Order.findById(orderId).populate("customerId", "mobile name").lean()
        .then(order => {
          if (!order) return;
          const mobile = order.customerId?.mobile;
          const restaurantName = settings?.restaurantName || "FlowUp Restaurant";
          const common = {
            mobile,
            countryContext: settings?.countryCode,
            logContext: {
              restaurantId,
              customerId: order.customerId?._id,
              orderId: order._id,
              countryCode: settings?.countryCode,
            },
            templateInput: { restaurantName, orderNumber: order.orderNumber },
          };
          if (notifyEvent === "out_for_delivery") {
            return sendOrderStatusWhatsApp({
              ...common,
              body: buildOutForDeliveryMessage({ orderNumber: order.orderNumber, restaurantName }),
              event: "out_for_delivery",
            });
          }
          if (notifyEvent === "delivered") {
            return sendOrderStatusWhatsApp({
              ...common,
              body: buildDeliveredMessage({ orderNumber: order.orderNumber, restaurantName }),
              event: "delivered",
            });
          }
        });
    })
    .catch(err => console.error(`[WhatsApp] ${notifyEvent} error:`, err.message));
}

// ── Edge-case guard: valid ObjectId ──────────────────────────────
function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// ── Shared order transition helper ───────────────────────────────
async function transitionOrder(req, res, { fromStatus, toStatus, staffField, action, notifyEvent }) {
  try {
    const { id }       = req.params;
    const restaurantId = req.staff.restaurantId;

    // Guard: malformed ID returns 400, not a Mongoose cast error 500
    if (!isValidId(id)) {
      return res.status(400).json({ success: false, message: "Invalid order ID format" });
    }

    const order = await Order.findOne({ _id: id, restaurantId });

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    // Guard: double-transition (two chefs race to accept the same order)
    if (order.status !== fromStatus) {
      return res.status(409).json({
        success: false,
        message: `Order is already in '${order.status}' status — expected '${fromStatus}'.`,
      });
    }

    const oldStatus  = order.status;
    order.status     = toStatus;
    if (staffField)             order[staffField] = req.staff._id;
    if (toStatus === "COMPLETED") order.completedAt = new Date();
    if (toStatus === "ACCEPTED")  order.acceptedAt  = new Date();

    await order.save();

    // Emit real-time update to all connected clients in this restaurant's room
    emitToRestaurant(restaurantId, "order_status_updated", {
      orderId:     order._id,
      status:      order.status,
      acceptedBy:  order.acceptedBy  || null,
      preparedBy:  order.preparedBy  || null,
      servedBy:    order.servedBy    || null,
      completedAt: order.completedAt || null,
      acceptedAt:  order.acceptedAt  || null,
    });

    // Async audit log — fire-and-forget, never blocks response
    logActivity({
      staff:      req.staff,
      action,
      entityType: "Order",
      entityId:   order._id,
      oldValue:   oldStatus,
      newValue:   toStatus,
      req,
    });

    // Phase 18: WhatsApp notification for this transition — fire-and-forget.
    // The status guard above (order.status !== fromStatus → 409) already
    // prevents duplicate sends on repeated calls for the same transition.
    _notifyStaffTransition(restaurantId, order._id, notifyEvent);

    return res.status(200).json({
      success: true,
      message: `Order moved to ${toStatus}`,
      data:    order,
    });
  } catch (error) {
    console.error(`Staff Order Transition Error [${action}]:`, error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// ── GET /api/staff/orders ─────────────────────────────────────────
// Returns orders for the restaurant (paginated, with optional status filter)
exports.getOrders = async (req, res) => {
  try {
    const restaurantId = req.staff.restaurantId;
    const { status, page = 1, limit = 50 } = req.query;

    const effectiveLimit = Math.min(Number(limit) || 50, 100);
    const effectivePage  = Math.max(Number(page) || 1, 1);
    const skip = (effectivePage - 1) * effectiveLimit;

    const filter = { restaurantId };
    if (status) filter.status = status;

    const total = await Order.countDocuments(filter);

    const orders = await Order.find(filter)
      .populate("customerId", "name mobile address")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(effectiveLimit);

    return res.status(200).json({
      success: true,
      count:   orders.length,
      total,
      page:    effectivePage,
      limit:   effectiveLimit,
      data:    orders,
    });
  } catch (error) {
    console.error("Staff GetOrders Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── PATCH /api/staff/orders/:id/accept ───────────────────────────
exports.acceptOrder = (req, res) =>
  transitionOrder(req, res, {
    fromStatus: "PENDING",
    toStatus:   "ACCEPTED",
    staffField: "acceptedBy",
    action:     "Accepted Order",
  });

// ── PATCH /api/staff/orders/:id/preparing ────────────────────────
exports.preparingOrder = (req, res) =>
  transitionOrder(req, res, {
    fromStatus: "ACCEPTED",
    toStatus:   "PREPARING",
    staffField: "preparedBy",
    action:     "Started Preparing",
  });

// ── PATCH /api/staff/orders/:id/ready ────────────────────────────
exports.readyOrder = (req, res) =>
  transitionOrder(req, res, {
    fromStatus: "PREPARING",
    toStatus:   "READY",
    staffField: null,
    action:     "Marked Ready",
  });

// ── PATCH /api/staff/orders/:id/deliver ──────────────────────────
// Dine-in: READY → COMPLETED
// Delivery that's already OUT_FOR_DELIVERY: OUT_FOR_DELIVERY → COMPLETED
exports.deliverOrder = async (req, res) => {
  const { id } = req.params;
  const restaurantId = req.staff.restaurantId;

  if (!isValidId(id)) {
    return res.status(400).json({ success: false, message: "Invalid order ID format" });
  }

  const order = await Order.findOne({ _id: id, restaurantId });
  if (!order) {
    return res.status(404).json({ success: false, message: "Order not found" });
  }

  // For dine-in: READY → COMPLETED
  // For delivery: OUT_FOR_DELIVERY → COMPLETED
  const allowedFrom = order.orderType === "DELIVERY" ? "OUT_FOR_DELIVERY" : "READY";

  if (order.status !== allowedFrom) {
    return res.status(409).json({
      success: false,
      message: `Order is in '${order.status}' status — expected '${allowedFrom}'.`,
    });
  }

  return transitionOrder(req, res, {
    fromStatus: allowedFrom,
    toStatus:   "COMPLETED",
    staffField: "servedBy",
    action:     order.orderType === "DELIVERY" ? "Completed Delivery" : order.orderType === "TAKE_AWAY" ? "Completed Take Away" : "Delivered Order",
    // DELIVERED notification applies to delivery orders only (a dine-in/take-away
    // "completed" is not a delivery event).
    notifyEvent: order.orderType === "DELIVERY" ? "delivered" : undefined,
  });
};

// ── PATCH /api/staff/orders/:id/dispatch ─────────────────────────
// Delivery orders only: READY → OUT_FOR_DELIVERY
exports.dispatchOrder = async (req, res) => {
  const { id } = req.params;
  const restaurantId = req.staff.restaurantId;

  if (!isValidId(id)) {
    return res.status(400).json({ success: false, message: "Invalid order ID format" });
  }

  const order = await Order.findOne({ _id: id, restaurantId });
  if (!order) {
    return res.status(404).json({ success: false, message: "Order not found" });
  }

  if (order.orderType !== "DELIVERY") {
    return res.status(400).json({ success: false, message: "Dispatch is only for delivery orders" });
  }

  if (order.status !== "READY") {
    return res.status(409).json({
      success: false,
      message: `Cannot dispatch — order is in '${order.status}' status, expected 'READY'.`,
    });
  }

  return transitionOrder(req, res, {
    fromStatus: "READY",
    toStatus:   "OUT_FOR_DELIVERY",
    staffField: "servedBy",
    action:     "Dispatched Delivery",
    notifyEvent: "out_for_delivery",
  });
};
