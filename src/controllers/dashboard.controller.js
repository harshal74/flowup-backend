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


const getDashboardAnalytics = async (
  req,
  res
) => {
  try {
    const restaurantId =
      req.user.restaurantId;

    const now = new Date();

    const currentWeek =
      new Date();

    currentWeek.setDate(
      now.getDate() - 7
    );

    const previousWeek =
      new Date();

    previousWeek.setDate(
      now.getDate() - 14
    );

    // =====================
    // BASIC STATS
    // =====================

    const totalOrders =
      await Order.countDocuments({
        restaurantId,
      });

    const totalCustomers =
      await Customer.countDocuments({
        restaurantId,
      });

    const completedOrders =
      await Order.find({
        restaurantId,
        status: "COMPLETED",
      });

    const totalRevenue =
      completedOrders.reduce(
        (sum, order) =>
          sum + order.totalAmount,
        0
      );

    const pendingOrders =
      await Order.countDocuments({
        restaurantId,
        status: {
          $in: [
            "PENDING",
            "ACCEPTED",
            "PREPARING",
            "READY",
            "OUT_FOR_DELIVERY",
          ],
        },
      });

    // =====================
    // TRENDS
    // =====================

    const currentOrders =
      await Order.countDocuments({
        restaurantId,
        createdAt: {
          $gte: currentWeek,
        },
      });

    const previousOrders =
      await Order.countDocuments({
        restaurantId,
        createdAt: {
          $gte:
            previousWeek,
          $lt:
            currentWeek,
        },
      });

    const currentRevenueOrders =
      await Order.find({
        restaurantId,
        status: "COMPLETED",
        createdAt: {
          $gte: currentWeek,
        },
      });

    const previousRevenueOrders =
      await Order.find({
        restaurantId,
        status: "COMPLETED",
        createdAt: {
          $gte:
            previousWeek,
          $lt:
            currentWeek,
        },
      });

    const currentRevenue =
      currentRevenueOrders.reduce(
        (sum, order) =>
          sum + order.totalAmount,
        0
      );

    const previousRevenue =
      previousRevenueOrders.reduce(
        (sum, order) =>
          sum + order.totalAmount,
        0
      );

    const currentCustomers =
      await Order.distinct(
        "customerId",
        {
          restaurantId,
          createdAt: {
            $gte:
              currentWeek,
          },
        }
      );

    const previousCustomers =
      await Order.distinct(
        "customerId",
        {
          restaurantId,
          createdAt: {
            $gte:
              previousWeek,
            $lt:
              currentWeek,
          },
        }
      );

    const ordersTrend =
      previousOrders === 0
        ? 100
        : Number(
            (
              ((currentOrders -
                previousOrders) /
                previousOrders) *
              100
            ).toFixed(1)
          );

    const revenueTrend =
      previousRevenue === 0
        ? 100
        : Number(
            (
              ((currentRevenue -
                previousRevenue) /
                previousRevenue) *
              100
            ).toFixed(1)
          );

    const customersTrend =
      previousCustomers
        .length === 0
        ? 100
        : Number(
            (
              ((currentCustomers.length -
                previousCustomers.length) /
                previousCustomers.length) *
              100
            ).toFixed(1)
          );

   // =====================
// REVENUE CHART
// =====================

const revenueOrders =
  await Order.find({
    restaurantId,
    status: "COMPLETED",
    createdAt: {
      $gte: previousWeek,
    },
  });

const revenueMap = {};

// Store revenue by date
revenueOrders.forEach((order) => {
  const day = new Date(
    order.createdAt
  ).toLocaleDateString(
    "en-US",
    {
      weekday: "short",
    }
  );

  revenueMap[day] =
    (revenueMap[day] || 0) +
    order.totalAmount;
});

// Always return last 7 days
const revenueChart = [];

for (let i = 6; i >= 0; i--) {
  const date = new Date();

  date.setDate(
    date.getDate() - i
  );

  const day =
    date.toLocaleDateString(
      "en-US",
      {
        weekday: "short",
      }
    );

  revenueChart.push({
    date: day,
    revenue:
      revenueMap[day] || 0,
  });
}

    // =====================
    // ORDER STATUS
    // =====================

    const statusStats =
      await Order.aggregate([
        {
          $match: {
            restaurantId,
          },
        },
        {
          $group: {
            _id:
              "$status",
            value: {
              $sum: 1,
            },
          },
        },
      ]);

    const statusChart =
      statusStats.map(
        (item) => ({
          name:
            item._id,
          value:
            item.value,
        })
      );

    // =====================
    // TOP ITEMS
    // =====================

    const topItemsRaw =
      await Order.aggregate([
        {
          $match: {
            restaurantId,
          },
        },
        {
          $unwind:
            "$items",
        },
        {
          $group: {
            _id:
              "$items.name",
            orders: {
              $sum:
                "$items.quantity",
            },
          },
        },
        {
          $sort: {
            orders: -1,
          },
        },
        {
          $limit: 10,
        },
      ]);

    const topItems =
      topItemsRaw.map(
        (item) => ({
          name:
            item._id,
          orders:
            item.orders,
        })
      );

    // =====================
    // RECENT ORDERS
    // =====================

    const recentOrders =
      await Order.find({
        restaurantId,
      })
        .populate(
          "customerId",
          "name mobile"
        )
        .sort({
          createdAt: -1,
        })
        .limit(10);

    return res.status(200).json({
      success: true,
      data: {
        stats: {
          totalOrders,
          totalRevenue,
          totalCustomers,
          pendingOrders,
        },

        trends: {
          ordersTrend,
          revenueTrend,
          customersTrend,
        },

        revenueChart,
        statusChart,
        topItems,
        recentOrders,
      },
    });
  } catch (error) {
    console.error(
      "Dashboard Analytics Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Internal server error",
    });
  }
};

module.exports = {
  getDashboardAnalytics,
};

module.exports = {
  getDashboardStats,
  getRecentOrders,
  getTopSellingItems,
  getOrderStatusStats,
  getDashboardAnalytics
};