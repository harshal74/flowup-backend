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