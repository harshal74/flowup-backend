const Customer = require("../models/Customer");
const Order = require("../models/Order");
const Menu = require("../models/Menu");

// Dashboard Summary (simple, used by /stats route)
const getDashboardStats = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const totalOrders    = await Order.countDocuments({ restaurantId });
    const totalCustomers = await Customer.countDocuments({ restaurantId });
    const totalMenuItems = await Menu.countDocuments({ restaurantId });

    // BUG C FIX: use aggregation instead of loading all documents into memory
    const [revenueResult] = await Order.aggregate([
      { $match: { restaurantId, status: "COMPLETED" } },
      { $group: { _id: null, totalRevenue: { $sum: "$totalAmount" } } },
    ]);
    const totalRevenue = revenueResult?.totalRevenue || 0;

    const pendingOrders = await Order.countDocuments({ restaurantId, status: "PENDING" });
    return res.status(200).json({
      success: true,
      data: { totalOrders, totalCustomers, totalMenuItems, totalRevenue, pendingOrders },
    });
  } catch (error) {
    console.error("Dashboard Stats Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Recent Orders
const getRecentOrders = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const orders = await Order.find({ restaurantId })
      .populate("customerId", "name mobile")
      .sort({ createdAt: -1 })
      .limit(10);
    return res.status(200).json({ success: true, data: orders });
  } catch (error) {
    console.error("Recent Orders Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Top Selling Items
const getTopSellingItems = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const items = await Menu.find({ restaurantId }).sort({ totalOrders: -1 }).limit(10);
    return res.status(200).json({ success: true, data: items });
  } catch (error) {
    console.error("Top Selling Items Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Order Status Summary
const getOrderStatusStats = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const stats = await Order.aggregate([
      { $match: { restaurantId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    return res.status(200).json({ success: true, data: stats });
  } catch (error) {
    console.error("Order Status Stats Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────
// Helper: get date range for period + offset
//   period : "daily" | "weekly" | "monthly" | "total"
//   offset : 0 = current, -1 = one period back, etc.
// ─────────────────────────────────────────────────────────
function getDateRange(period, offset) {
  const off = offset || 0;
  const now = new Date();

  if (period === "daily") {
    const start = new Date(now);
    start.setDate(start.getDate() + off);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  if (period === "weekly") {
    const day = now.getDay(); // 0=Sun
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const start = new Date(now);
    start.setDate(now.getDate() + diffToMonday + off * 7);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  if (period === "monthly") {
    const start = new Date(now.getFullYear(), now.getMonth() + off, 1);
    const end = new Date(now.getFullYear(), now.getMonth() + off + 1, 0);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }

  // total — no date filter
  return { start: null, end: null };
}

// Build revenue chart data points for the given period/offset
async function buildRevenueChart(restaurantId, period, offset) {
  const { start, end } = getDateRange(period, offset);

  const matchQuery = { restaurantId, status: "COMPLETED" };
  if (start) matchQuery.createdAt = { $gte: start, $lte: end };

  const orders = await Order.find(matchQuery);

  if (period === "daily") {
    const map = {};
    orders.forEach((o) => {
      const h = new Date(o.createdAt).getHours();
      const label = `${h}:00`;
      map[label] = (map[label] || 0) + o.totalAmount;
    });
    return Array.from({ length: 24 }, (_, h) => {
      const label = `${h}:00`;
      return { date: label, revenue: map[label] || 0 };
    });
  }

  if (period === "weekly") {
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const map = {};
    orders.forEach((o) => {
      const d = new Date(o.createdAt).getDay();
      const label = days[d === 0 ? 6 : d - 1];
      map[label] = (map[label] || 0) + o.totalAmount;
    });
    return days.map((d) => ({ date: d, revenue: map[d] || 0 }));
  }

  if (period === "monthly") {
    const { start: mStart } = getDateRange("monthly", offset);
    const daysInMonth = new Date(mStart.getFullYear(), mStart.getMonth() + 1, 0).getDate();
    const map = {};
    orders.forEach((o) => {
      const day = new Date(o.createdAt).getDate();
      map[day] = (map[day] || 0) + o.totalAmount;
    });
    return Array.from({ length: daysInMonth }, (_, i) => ({
      date: `${i + 1}`,
      revenue: map[i + 1] || 0,
    }));
  }

  // total — last 12 months
  const now = new Date();
  const map = {};
  orders.forEach((o) => {
    const d = new Date(o.createdAt);
    const label = d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
    map[label] = (map[label] || 0) + o.totalAmount;
  });
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (11 - i), 1);
    const label = d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
    return { date: label, revenue: map[label] || 0 };
  });
}

// ─────────────────────────────────────────────────────────
// Main Analytics Endpoint
// Query params:
//   period  : "daily" | "weekly" | "monthly" | "total"  (default: "weekly")
//   offset  : integer, 0 = current, -1 = previous, etc.  (default: 0)
// ─────────────────────────────────────────────────────────
const getDashboardAnalytics = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const period = req.query.period || "weekly";
    const offset = parseInt(req.query.offset || "0", 10);

    const { start, end } = getDateRange(period, offset);
    const prev = getDateRange(period, offset - 1);

    // Current period match
    const currentMatch = { restaurantId };
    if (start) currentMatch.createdAt = { $gte: start, $lte: end };

    // Previous period match (for trends)
    const prevMatch = { restaurantId };
    if (prev.start) prevMatch.createdAt = { $gte: prev.start, $lte: prev.end };

    // ── STATS ──────────────────────────────────────────
    const totalOrders = await Order.countDocuments(currentMatch);

    const totalCustomers = await Customer.countDocuments(
      start ? { restaurantId, createdAt: { $gte: start, $lte: end } } : { restaurantId }
    );

    const completedOrders = await Order.find({ ...currentMatch, status: "COMPLETED" });
    const totalRevenue = completedOrders.reduce((sum, o) => sum + o.totalAmount, 0);

    // Pending always shows live count
    const pendingOrders = await Order.countDocuments({
      restaurantId,
      status: { $in: ["PENDING", "ACCEPTED", "PREPARING", "READY", "OUT_FOR_DELIVERY"] },
    });

    // ── TRENDS ─────────────────────────────────────────
    let ordersTrend = 0;
    let revenueTrend = 0;
    let customersTrend = 0;

    if (period !== "total") {
      const prevOrdersCount = await Order.countDocuments(prevMatch);
      const prevCompleted = await Order.find({ ...prevMatch, status: "COMPLETED" });
      const prevRevenue = prevCompleted.reduce((sum, o) => sum + o.totalAmount, 0);
      const prevCustomers = await Customer.countDocuments(
        prev.start ? { restaurantId, createdAt: { $gte: prev.start, $lte: prev.end } } : { restaurantId }
      );

      ordersTrend =
        prevOrdersCount === 0
          ? totalOrders > 0 ? 100 : 0
          : Number((((totalOrders - prevOrdersCount) / prevOrdersCount) * 100).toFixed(1));

      revenueTrend =
        prevRevenue === 0
          ? totalRevenue > 0 ? 100 : 0
          : Number((((totalRevenue - prevRevenue) / prevRevenue) * 100).toFixed(1));

      customersTrend =
        prevCustomers === 0
          ? totalCustomers > 0 ? 100 : 0
          : Number((((totalCustomers - prevCustomers) / prevCustomers) * 100).toFixed(1));
    }

    // ── REVENUE CHART ──────────────────────────────────
    const revenueChart = await buildRevenueChart(restaurantId, period, offset);

    // ── ORDER STATUS CHART (always all-time) ───────────
    const statusStats = await Order.aggregate([
      { $match: { restaurantId } },
      { $group: { _id: "$status", value: { $sum: 1 } } },
    ]);
    const statusChart = statusStats.map((item) => ({ name: item._id, value: item.value }));

    // ── TOP ITEMS ──────────────────────────────────────
    const topItemsRaw = await Order.aggregate([
      { $match: currentMatch },
      { $unwind: "$items" },
      { $group: { _id: "$items.name", orders: { $sum: "$items.quantity" } } },
      { $sort: { orders: -1 } },
      { $limit: 10 },
    ]);
    const topItems = topItemsRaw.map((item) => ({ name: item._id, orders: item.orders }));

    // ── RECENT ORDERS ──────────────────────────────────
    const recentOrders = await Order.find({ restaurantId })
      .populate("customerId", "name mobile")
      .sort({ createdAt: -1 })
      .limit(10);

    // ── PERIOD LABEL ───────────────────────────────────
    let periodLabel = "All Time";
    if (period !== "total" && start) {
      if (period === "daily") {
        periodLabel = start.toLocaleDateString("en-IN", {
          weekday: "long", day: "numeric", month: "short", year: "numeric",
        });
      } else if (period === "weekly") {
        periodLabel = `${start.toLocaleDateString("en-IN", { day: "numeric", month: "short" })} – ${end.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`;
      } else if (period === "monthly") {
        periodLabel = start.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        period,
        offset,
        periodLabel,
        stats: { totalOrders, totalRevenue, totalCustomers, pendingOrders },
        trends: { ordersTrend, revenueTrend, customersTrend },
        revenueChart,
        statusChart,
        topItems,
        recentOrders,
      },
    });
  } catch (error) {
    console.error("Dashboard Analytics Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = {
  getDashboardStats,
  getRecentOrders,
  getTopSellingItems,
  getOrderStatusStats,
  getDashboardAnalytics,
};
