const Customer = require("../models/Customer");
const Order = require("../models/Order");
const Menu = require("../models/Menu");

// Dashboard Summary
const getDashboardStats = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;

    const totalOrders = await Order.countDocuments({
      restaurantId,
    });

    const totalCustomers = await Customer.countDocuments({
      restaurantId,
    });

    const totalMenuItems = await Menu.countDocuments({
      restaurantId,
    });

    const completedOrders = await Order.find({
      restaurantId,
      status: "COMPLETED",
    });

    const totalRevenue = completedOrders.reduce(
      (sum, order) => sum + order.totalAmount,
      0
    );

    const pendingOrders = await Order.countDocuments({
      restaurantId,
      status: "PENDING",
    });

    return res.status(200).json({
      success: true,
      data: {
        totalOrders,
        totalCustomers,
        totalMenuItems,
        totalRevenue,
        pendingOrders,
      },
    });
  } catch (error) {
    console.error("Dashboard Stats Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Recent Orders
const getRecentOrders = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;

    const orders = await Order.find({
      restaurantId,
    })
      .populate("customerId", "name mobile")
      .sort({ createdAt: -1 })
      .limit(10);

    return res.status(200).json({
      success: true,
      data: orders,
    });
  } catch (error) {
    console.error("Recent Orders Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Top Selling Items
const getTopSellingItems = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;

    const items = await Menu.find({
      restaurantId,
    })
      .sort({ totalOrders: -1 })
      .limit(10);

    return res.status(200).json({
      success: true,
      data: items,
    });
  } catch (error) {
    console.error("Top Selling Items Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Order Status Summary
const getOrderStatusStats = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;

    const stats = await Order.aggregate([
      {
        $match: {
          restaurantId,
        },
      },
      {
        $group: {
          _id: "$status",
          count: {
            $sum: 1,
          },
        },
      },
    ]);

    return res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error("Order Status Stats Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

module.exports = {
  getDashboardStats,
  getRecentOrders,
  getTopSellingItems,
  getOrderStatusStats,
};