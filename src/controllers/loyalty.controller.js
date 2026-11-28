"use strict";
/**
 * Loyalty Points controller — tenant-scoped, server-enforced.
 *
 * Points rules:
 *   EARN  : 1 point per ₹100 on COMPLETED+PAID orders (called from order settle).
 *   REDEEM: 1 pt = ₹1 discount, min 10 pts, max 20% of order total.
 *
 * Routes mounted at /api/loyalty (admin only except GET /balance for customers).
 */

const mongoose    = require("mongoose");
const LoyaltyPoints = require("../models/LoyaltyPoints");
const Order       = require("../models/Order");
const Customer    = require("../models/Customer");

const POINTS_PER_RUPEE = 1 / 100;    // 1 point per ₹100 spent
const POINTS_RUPEE_VALUE = 1;         // 1 pt = ₹1
const MIN_REDEEM_POINTS  = 10;        // must have at least 10 pts to redeem
const MAX_REDEEM_PCT     = 0.20;      // max 20% of order total

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// ── POST /api/loyalty/earn (internal — called after order settlement) ─
// Body: { orderId }  — restaurantId from token, points calculated from order.
exports.earnPoints = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { orderId } = req.body;
    if (!orderId || !isValidId(orderId)) {
      return res.status(400).json({ success: false, message: "Valid orderId required." });
    }

    const order = await Order.findOne({ _id: orderId, restaurantId }).lean();
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
    if (order.status !== "COMPLETED" || order.paymentStatus !== "PAID") {
      return res.status(400).json({ success: false, message: "Points only earned on completed + paid orders." });
    }
    if (!order.customerId) {
      return res.status(400).json({ success: false, message: "No customer linked to this order." });
    }
    // Check not already earned for this order
    const existing = await LoyaltyPoints.findOne({
      restaurantId,
      customerId: order.customerId,
      "transactions.orderId": order._id,
      "transactions.type": "EARN",
    }).lean();
    if (existing) {
      return res.status(409).json({ success: false, message: "Points already earned for this order." });
    }

    const points = Math.floor(order.totalAmount * POINTS_PER_RUPEE);
    if (points < 1) {
      return res.status(200).json({ success: true, message: "Order too small to earn points.", pointsEarned: 0 });
    }

    const record = await LoyaltyPoints.findOneAndUpdate(
      { restaurantId, customerId: order.customerId },
      {
        $inc: { balance: points, lifetimeEarned: points },
        $push: { transactions: { type: "EARN", points, orderId: order._id, note: `Order #${order.orderNumber}` } },
      },
      { upsert: true, new: true }
    );

    return res.status(200).json({ success: true, pointsEarned: points, balance: record.balance });
  } catch (err) {
    console.error("Loyalty earnPoints error:", err);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ── GET /api/loyalty/:customerId — admin view of a customer's balance ─
exports.getCustomerPoints = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { customerId } = req.params;
    if (!isValidId(customerId)) return res.status(400).json({ success: false, message: "Invalid customerId." });

    const record = await LoyaltyPoints.findOne({ restaurantId, customerId }).lean();
    if (!record) {
      return res.status(200).json({ success: true, data: { balance: 0, lifetimeEarned: 0, lifetimeRedeemed: 0, transactions: [] } });
    }
    return res.status(200).json({ success: true, data: record });
  } catch (err) {
    console.error("Loyalty getCustomerPoints error:", err);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ── POST /api/loyalty/:customerId/redeem ─────────────────────────
// Body: { points, orderId? }  — validates rules server-side.
exports.redeemPoints = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { customerId } = req.params;
    if (!isValidId(customerId)) return res.status(400).json({ success: false, message: "Invalid customerId." });

    const pointsToRedeem = Number(req.body?.points);
    if (!Number.isInteger(pointsToRedeem) || pointsToRedeem < MIN_REDEEM_POINTS) {
      return res.status(400).json({ success: false, message: `Minimum ${MIN_REDEEM_POINTS} points required to redeem.` });
    }

    // Validate against an order if provided
    const { orderId } = req.body;
    if (orderId && !isValidId(orderId)) {
      return res.status(400).json({ success: false, message: "Invalid orderId." });
    }

    if (orderId) {
      const order = await Order.findOne({ _id: orderId, restaurantId }).lean();
      if (!order) return res.status(404).json({ success: false, message: "Order not found." });
      const maxAllowed = Math.floor(order.totalAmount * MAX_REDEEM_PCT);
      if (pointsToRedeem * POINTS_RUPEE_VALUE > maxAllowed) {
        return res.status(400).json({
          success: false,
          message: `Cannot redeem more than ₹${maxAllowed} (20% of order total ₹${order.totalAmount.toFixed(2)}).`,
        });
      }
    }

    // Atomic deduct
    const record = await LoyaltyPoints.findOneAndUpdate(
      { restaurantId, customerId, balance: { $gte: pointsToRedeem } },
      {
        $inc: { balance: -pointsToRedeem, lifetimeRedeemed: pointsToRedeem },
        $push: {
          transactions: {
            type: "REDEEM",
            points: -pointsToRedeem,
            orderId: orderId || null,
            note: orderId ? `Redeemed on order` : "Manual redemption",
          },
        },
      },
      { new: true }
    );

    if (!record) {
      return res.status(400).json({ success: false, message: "Insufficient points balance." });
    }

    return res.status(200).json({
      success: true,
      pointsRedeemed: pointsToRedeem,
      discountAmount: pointsToRedeem * POINTS_RUPEE_VALUE,
      balance: record.balance,
    });
  } catch (err) {
    console.error("Loyalty redeemPoints error:", err);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ── GET /api/loyalty — admin list of all customers' balances ─────
exports.listAll = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const page  = Math.max(Number(req.query.page)  || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const skip  = (page - 1) * limit;

    const [records, total] = await Promise.all([
      LoyaltyPoints.find({ restaurantId, balance: { $gt: 0 } })
        .populate("customerId", "name mobile")
        .sort({ balance: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      LoyaltyPoints.countDocuments({ restaurantId, balance: { $gt: 0 } }),
    ]);

    return res.status(200).json({ success: true, total, page, limit, data: records });
  } catch (err) {
    console.error("Loyalty listAll error:", err);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};
