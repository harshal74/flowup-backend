const express = require("express");
const { rateLimit } = require("../middleware/rateLimit");
const resolvePublicRestaurant = require("../middleware/resolvePublicRestaurant");
const protect = require("../middleware/auth.middleware");
const {
  createDeliveryEnquiry,
  getDeliveryEnquiries,
  getDeliveryEnquiryById,
  updateDeliveryEnquiry,
  deleteDeliveryEnquiry,
} = require("../controllers/deliveryEnquiry.controller");

const router = express.Router();

// Rate limit: 3 submissions per 10 min, keyed by IP + mobile to prevent spam
// while allowing different customers at the same venue to submit independently.
const enquiryLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  message: "Too many enquiry submissions. Please try again in a few minutes.",
  keyGenerator: (req) => {
    const ip     = req.ip || "unknown";
    const mobile = req.body?.mobile;
    if (mobile && typeof mobile === "string" && mobile.trim()) {
      return `enquiry:${ip}:${mobile.trim()}`;
    }
    return `enquiry:ip:${ip}`;
  },
});

// ── Public (customer) ─────────────────────────────────────────────
router.post("/", enquiryLimiter, resolvePublicRestaurant, createDeliveryEnquiry);

// ── Protected (admin) ─────────────────────────────────────────────
router.get("/",     protect, getDeliveryEnquiries);
router.get("/:id",  protect, getDeliveryEnquiryById);
router.patch("/:id",  protect, updateDeliveryEnquiry);
router.delete("/:id", protect, deleteDeliveryEnquiry);

module.exports = router;
