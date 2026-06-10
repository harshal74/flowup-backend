const express = require("express");

const {
  getDashboardStats,
  getRecentOrders,
  getTopSellingItems,
  getOrderStatusStats,
} = require("../controllers/dashboard.controller");

const protect = require("../middleware/auth.middleware");

const router = express.Router();

router.get(
  "/stats",
  protect,
  getDashboardStats
);

router.get(
  "/recent-orders",
  protect,
  getRecentOrders
);

router.get(
  "/top-items",
  protect,
  getTopSellingItems
);

router.get(
  "/order-status",
  protect,
  getOrderStatusStats
);

module.exports = router;