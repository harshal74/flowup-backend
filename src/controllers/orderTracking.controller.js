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
        "createdAt acceptedAt completedAt rejectedAt rejectionReason cancellationReason"
      )
      .lean();
    if (!order || !verifyTrackingToken(order, token)) return notFound();

    const settings = await Setting.findOne({ restaurantId: order.restaurantId })
      .select("restaurantName contactNumber averagePreparationTime")
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
      },
    });
  } catch (err) {
    console.error("[OrderTracking] status error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to load order status." });
  }
};
