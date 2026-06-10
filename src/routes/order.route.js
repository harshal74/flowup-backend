const express = require("express");

const {
  createOrder,
  getOrders,
  getOrderById,
  acceptOrder,
  rejectOrder,
  updateOrderStatus,
} = require("../controllers/order.controller");

const protect = require("../middleware/auth.middleware");

const router = express.Router();

router.post("/", createOrder);

router.get("/", protect, getOrders);

router.get("/:id", protect, getOrderById);

router.patch(
  "/:id/accept",
  protect,
  acceptOrder
);

router.patch(
  "/:id/reject",
  protect,
  rejectOrder
);

router.patch(
  "/:id/status",
  protect,
  updateOrderStatus
);

module.exports = router;