const express = require("express");
const { rateLimit } = require("../middleware/rateLimit");
const { getOrderStatus, submitFeedback } = require("../controllers/orderTracking.controller");

const router = express.Router();

// Status page polls every ~10 s; 60/min per IP leaves room for several
// open orders on shared restaurant Wi-Fi while blocking token guessing.
const statusLimiter = rateLimit({
  windowMs: 60000,
  max: 60,
  message: "Too many requests. Please wait a moment.",
});

router.get("/:orderNumber", statusLimiter, getOrderStatus);

const feedbackLimiter = rateLimit({
  windowMs: 60000,
  max: 10,
  message: "Too many requests. Please wait a moment.",
});
router.post("/:orderNumber/feedback", feedbackLimiter, submitFeedback);

module.exports = router;
