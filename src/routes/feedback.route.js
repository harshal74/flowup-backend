/**
 * Customer ratings — admin only.
 *   GET /api/feedback?page=&limit=&rating=
 *   → { stats: { average, count, distribution{1..5} }, data: [...], pagination }
 */

const express = require("express");
const protect = require("../middleware/auth.middleware");
const Feedback = require("../models/Feedback");

const router = express.Router();

router.get("/", protect, async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const rating = Number(req.query.rating);
    const filter = { restaurantId, ...(Number.isInteger(rating) && rating >= 1 && rating <= 5 ? { rating } : {}) };

    const [rows, total, agg] = await Promise.all([
      Feedback.find(filter)
        .populate("customerId", "name")
        .populate("orderId", "orderNumber orderType tableNumber")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Feedback.countDocuments(filter),
      Feedback.aggregate([
        { $match: { restaurantId } },
        { $group: { _id: "$rating", n: { $sum: 1 } } },
      ]),
    ]);

    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let count = 0, sum = 0;
    for (const g of agg) { distribution[g._id] = g.n; count += g.n; sum += g._id * g.n; }

    return res.status(200).json({
      success: true,
      stats: { average: count ? Math.round((sum / count) * 10) / 10 : 0, count, distribution },
      data: rows.map((f) => ({
        _id: String(f._id),
        rating: f.rating,
        comment: f.comment || "",
        customerName: f.customerId?.name || "Guest",
        orderNumber: f.orderId?.orderNumber || "",
        orderType: f.orderId?.orderType || "",
        tableNumber: f.orderId?.tableNumber ?? null,
        createdAt: f.createdAt,
      })),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err) {
    console.error("[Feedback] list error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to load feedback." });
  }
});

module.exports = router;
