const express = require("express");

const {
  getSettings,
  updateSettings,
  openShop,
  closeShop,
  toggleFeedback,
  toggleWhatsappNotifications,
} = require("../controllers/settings.controller");

const protect = require("../middleware/auth.middleware");

const router = express.Router();

// GET /settings is intentionally public — user frontend needs shopOpen, restaurantName,
// deliveryCharge etc. to render the menu. Sensitive admin-only fields (upiId etc.)
// are only set via the protected PUT endpoint.
router.get("/", getSettings);

router.put("/", protect, updateSettings);

router.patch("/open", protect, openShop);

router.patch("/close", protect, closeShop);

router.patch(
  "/feedback",
  protect,
  toggleFeedback
);

router.patch(
  "/whatsapp",
  protect,
  toggleWhatsappNotifications
);

module.exports = router;