const express = require("express");
const { getNotifications, markNotificationRead, deleteNotification } = require("../controllers/notification.controller");
const protect = require("../middleware/auth.middleware");

const router = express.Router();

/**
 * Admin notifications (Inventory Step 4 introduces LOW_STOCK).
 * All routes require an authenticated restaurant admin (`protect` → req.user);
 * tenant identity is req.user.restaurantId — never accepted from the client.
 */
router.get("/", protect, getNotifications);
router.patch("/:id/read", protect, markNotificationRead);
router.delete("/:id", protect, deleteNotification);

module.exports = router;
