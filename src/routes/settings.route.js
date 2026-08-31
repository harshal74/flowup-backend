const express = require("express");
const resolvePublicRestaurant = require("../middleware/resolvePublicRestaurant");

const {
  getSettings,
  updateSettings,
  openShop,
  closeShop,
  toggleFeedback,
  toggleWhatsappNotifications,
  toggleOnlineDelivery,
} = require("../controllers/settings.controller");

const protect = require("../middleware/auth.middleware");

const router = express.Router();

// GET /settings — public: uses resolvePublicRestaurant OR admin's JWT restaurantId
// The resolver handles ?restaurantId= for customer frontend.
// Admin frontend hits this without query param but with JWT — protect handles that separately.
router.get("/", resolvePublicRestaurant, getSettings);

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

router.patch(
  "/online-delivery",
  protect,
  toggleOnlineDelivery
);

module.exports = router;