const express = require("express");
const router = express.Router();
const protect = require("../middleware/auth.middleware");

const {
  getUnpaidOrders,
  generateBill,
  confirmPayment,
  cancelBill,
  getBillHistory,
  getBillById,
} = require("../controllers/billing.controller");

// Static routes first (before /:billId)
router.get("/orders",  protect, getUnpaidOrders);
router.post("/generate", protect, generateBill);
router.get("/history", protect, getBillHistory);

// Parameterised routes
router.patch("/:billId/confirm", protect, confirmPayment);
router.delete("/:billId",        protect, cancelBill);
router.get("/:billId",           protect, getBillById);

module.exports = router;
