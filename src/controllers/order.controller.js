const Order = require("../models/Order");
const Menu = require("../models/Menu");
const Customer = require("../models/Customer");
const { emitToRestaurant } = require("../socket");

// ─────────────────────────────────────────────────────────────────
// Create Order  (public — no auth required)
// After saving, emits  "new_order"  to the restaurant room so the
// admin dashboard receives it instantly without polling.
// ─────────────────────────────────────────────────────────────────
const createOrder = async (req, res) => {
  try {
    const {
      orderType,
      tableNumber,
      customer,
      items,
      note,
      address,
    } = req.body;

    const restaurantId = "FLOWUP001";

    if (!customer) {
      return res.status(400).json({ success: false, message: "Customer details are required" });
    }

    if (!orderType || !["DINE_IN", "DELIVERY"].includes(orderType)) {
      return res.status(400).json({ success: false, message: "Invalid order type" });
    }

    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, message: "Order items are required" });
    }

    if (orderType === "DINE_IN" && (!tableNumber || tableNumber < 1)) {
      return res.status(400).json({ success: false, message: "Table number is required for dine-in orders" });
    }

    if (orderType === "DELIVERY" && !customer.address && !address) {
      return res.status(400).json({ success: false, message: "Delivery address is required" });
    }

    // Find / create customer
    let existingCustomer = await Customer.findOne({ restaurantId, mobile: customer.mobile });

    if (existingCustomer && existingCustomer.isBlocked) {
      return res.status(403).json({ success: false, message: "Customer is blocked" });
    }

    if (!existingCustomer) {
      existingCustomer = await Customer.create({
        restaurantId,
        name: customer.name,
        mobile: customer.mobile,
        address: customer.address || "",
      });
    }

    let orderItems = [];
    let totalItems = 0;
    let subtotalAmount = 0;

    for (const item of items) {
      const menuItem = await Menu.findById(item.menuId);

      if (!menuItem) {
        return res.status(404).json({ success: false, message: "Menu item not found" });
      }

      if (!menuItem.isAvailable) {
        return res.status(400).json({ success: false, message: `${menuItem.name} is currently unavailable` });
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

    const order = await Order.create({
      restaurantId,
      orderNumber: `ORD-${Date.now()}`,
      customerId: existingCustomer._id,
      orderType,
      tableNumber: orderType === "DINE_IN" ? tableNumber : null,
      items: orderItems,
      totalItems,
      subtotalAmount,
      totalAmount: subtotalAmount,
      note: note || "",
      address: orderType === "DELIVERY" ? (address || customer.address || "") : "",
    });

    // Update customer stats
    existingCustomer.totalOrders += 1;
    existingCustomer.totalSpent += subtotalAmount;
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
      data: order,
    });
  } catch (error) {
    console.error("Create Order Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────────
// Get All Orders
// ─────────────────────────────────────────────────────────────────
const getOrders = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;

    const orders = await Order.find({ restaurantId })
      .populate("customerId", "name mobile address")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: orders.length,
      data: orders,
    });
  } catch (error) {
    console.error("Get Orders Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────────
// Get Single Order
// ─────────────────────────────────────────────────────────────────
const getOrderById = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate("customerId", "name mobile address");

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
// Accept Order
// Emits  "order_status_updated"  so the admin kanban and any
// customer order-tracking page update without polling.
// ─────────────────────────────────────────────────────────────────
const acceptOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    order.status = "ACCEPTED";
    order.acceptedAt = new Date();
    await order.save();

    // ── Emit status update ──────────────────────────────────────
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
// Reject Order
// ─────────────────────────────────────────────────────────────────
const rejectOrder = async (req, res) => {
  try {
    const { reason = "" } = req.body || {};

    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    order.status = "REJECTED";
    order.rejectedAt = new Date();
    order.rejectionReason = reason;
    await order.save();

    // ── Emit status update ──────────────────────────────────────
    emitToRestaurant(order.restaurantId, "order_status_updated", {
      orderId: order._id,
      status: order.status,
      rejectedAt: order.rejectedAt,
      rejectionReason: reason,
    });

    return res.status(200).json({ success: true, message: "Order rejected successfully", data: order });
  } catch (error) {
    console.error("Reject Order Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────────
// Update Order Status (general)
// ─────────────────────────────────────────────────────────────────
const updateOrderStatus = async (req, res) => {
  try {
    const { status } = req.body;

    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    order.status = status;

    if (status === "COMPLETED") {
      order.completedAt = new Date();
    }

    await order.save();

    // ── Emit status update ──────────────────────────────────────
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
