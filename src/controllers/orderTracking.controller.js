/**
 * Public order status — GET /api/public/orders/:orderNumber
 * Header: x-order-token: <trackingToken returned when the order was placed>
 *
 * Unknown order, missing token and wrong token all return the same 404 so the
 * endpoint can't be used to check whether an order number exists.
 * Returns only what the customer needs; no customer phone/address.
 */

const Order = require("../models/Order");
const Setting = require("../models/Setting");
const Feedback = require("../models/Feedback");
const { verifyTrackingToken } = require("../utils/orderTracking");

const ORDER_NUMBER_RE = /^[A-Za-z0-9-]{4,64}$/;

exports.getOrderStatus = async (req, res) => {
  res.set("Cache-Control", "no-store");
  const notFound = () => res.status(404).json({ success: false, message: "Order not found." });

  try {
    const orderNumber = String(req.params.orderNumber || "").trim();
    const token = req.headers["x-order-token"];
    if (!ORDER_NUMBER_RE.test(orderNumber) || typeof token !== "string" || !token) return notFound();

    const order = await Order.findOne({ orderNumber })
      .select(
        "_id restaurantId orderNumber orderType tableNumber status paymentMethod paymentStatus refundStatus " +
        "items totalItems subtotalAmount deliveryCharge taxAmount discountAmount totalAmount estimatedTime " +
        "createdAt acceptedAt completedAt rejectedAt rejectionReason cancellationReason feedbackSubmitted"
      )
      .lean();
    if (!order || !verifyTrackingToken(order, token)) return notFound();

    const settings = await Setting.findOne({ restaurantId: order.restaurantId })
      .select("restaurantName contactNumber averagePreparationTime feedbackEnabled")
      .lean();

    return res.status(200).json({
      success: true,
      data: {
        orderNumber: order.orderNumber,
        restaurantId: order.restaurantId,
        restaurantName: settings?.restaurantName || "",
        contactNumber: settings?.contactNumber || "",
        orderType: order.orderType,
        tableNumber: order.tableNumber ?? null,
        status: order.status,
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        refundStatus: order.refundStatus || "NONE",
        items: (order.items || []).map((i) => ({
          name: i.name, quantity: i.quantity, price: i.price, subtotal: i.subtotal,
        })),
        totalItems: order.totalItems,
        subtotalAmount: order.subtotalAmount,
        deliveryCharge: order.deliveryCharge || 0,
        taxAmount: order.taxAmount || 0,
        discountAmount: order.discountAmount || 0,
        totalAmount: order.totalAmount,
        estimatedTime: order.estimatedTime ?? settings?.averagePreparationTime ?? null,
        createdAt: order.createdAt,
        acceptedAt: order.acceptedAt || null,
        completedAt: order.completedAt || null,
        rejectedAt: order.rejectedAt || null,
        rejectionReason: order.rejectionReason || "",
        cancellationReason: order.cancellationReason || "",
        feedbackEnabled: settings?.feedbackEnabled !== false,
        feedbackSubmitted: !!order.feedbackSubmitted,
      },
    });
  } catch (err) {
    console.error("[OrderTracking] status error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to load order status." });
  }
};

// POST /api/public/orders/:orderNumber/feedback   body: { rating 1–5, comment? }
// Only the customer who placed the order (tracking token), only once, only
// after it has been served/delivered, and only if the restaurant allows feedback.
exports.submitFeedback = async (req, res) => {
  const notFound = () => res.status(404).json({ success: false, message: "Order not found." });
  try {
    const orderNumber = String(req.params.orderNumber || "").trim();
    const token = req.headers["x-order-token"];
    if (!ORDER_NUMBER_RE.test(orderNumber) || typeof token !== "string" || !token) return notFound();

    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ success: false, message: "Please choose a rating from 1 to 5 stars." });
    }
    const comment = typeof req.body?.comment === "string" ? req.body.comment.trim().slice(0, 500) : "";

    const order = await Order.findOne({ orderNumber })
      .select("_id restaurantId customerId status feedbackSubmitted")
      .lean();
    if (!order || !verifyTrackingToken(order, token)) return notFound();

    if (order.status !== "COMPLETED") {
      return res.status(400).json({ success: false, message: "You can rate your order once it has been served." });
    }
    const settings = await Setting.findOne({ restaurantId: order.restaurantId }).select("feedbackEnabled").lean();
    if (settings?.feedbackEnabled === false) {
      return res.status(403).json({ success: false, message: "Feedback is turned off for this restaurant." });
    }

    // Atomic once-only claim on the order
    const claimed = await Order.findOneAndUpdate(
      { _id: order._id, feedbackSubmitted: { $ne: true } },
      { $set: { feedbackSubmitted: true } },
      { returnDocument: "after" }
    ).lean();
    if (!claimed) {
      return res.status(409).json({ success: false, message: "You have already rated this order. Thank you!" });
    }

    try {
      await Feedback.create({
        restaurantId: order.restaurantId,
        customerId: order.customerId,
        orderId: order._id,
        rating,
        comment,
      });
    } catch (err) {
      if (err && err.code === 11000) {
        return res.status(409).json({ success: false, message: "You have already rated this order. Thank you!" });
      }
      await Order.updateOne({ _id: order._id }, { $set: { feedbackSubmitted: false } }); // allow retry
      throw err;
    }

    return res.status(201).json({ success: true, message: "Thank you for your feedback!" });
  } catch (err) {
    console.error("[OrderTracking] feedback error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to save feedback." });
  }
};
