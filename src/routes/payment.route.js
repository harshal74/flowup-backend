const express = require("express");
const { rateLimit } = require("../middleware/rateLimit");
const protect = require("../middleware/auth.middleware");
const resolvePublicRestaurant = require("../middleware/resolvePublicRestaurant");
const {
  createPaymentOrder,
  verifyAndCreateOrder,
  getPaymentConfig,
  razorpayWebhook,
  refundPayment,
} = require("../controllers/payment.controller");

const router = express.Router();

// Rate limit payment endpoints to prevent abuse
const paymentLimiter = rateLimit({
  windowMs: 60000,
  max: 10,
  message: "Too many payment requests. Please wait a moment.",
});

// Public — customer frontend fetches payment config (mode + public key)
router.get("/config", resolvePublicRestaurant, getPaymentConfig);

// Public — customer creates a Razorpay order before paying
router.post("/create-order", paymentLimiter, resolvePublicRestaurant, createPaymentOrder);

// Public — customer sends payment proof, backend verifies + creates FlowUp order
router.post("/verify-and-create-order", paymentLimiter, verifyAndCreateOrder);

// Razorpay webhook — server-to-server, no auth token (verified by signature)
router.post("/webhook", razorpayWebhook);

// Admin — initiate refund for a rejected prepaid order
router.post("/refund/:orderId", protect, refundPayment);

module.exports = router;
