const express = require("express");
const platformAuth = require("../middleware/platformAuth");
const {
  createRestaurant,
  listRestaurants,
  getRestaurantDetail,
  getRestaurantStats,
  suspendRestaurant,
  reactivateRestaurant,
  getPlatformSummary,
  getAuditLogs,
  updateSlug,
} = require("../controllers/platform.controller");

const router = express.Router();

// All platform routes require SUPER_ADMIN authentication
router.use(platformAuth);

// Summary / dashboard
router.get("/summary", getPlatformSummary);
router.get("/audit-logs", getAuditLogs);

// Restaurant CRUD
router.get("/restaurants", listRestaurants);
router.post("/restaurants", createRestaurant);
router.get("/restaurants/:restaurantId", getRestaurantDetail);
router.get("/restaurants/:restaurantId/stats", getRestaurantStats);

// Restaurant status management
router.patch("/restaurants/:restaurantId/suspend", suspendRestaurant);
router.patch("/restaurants/:restaurantId/reactivate", reactivateRestaurant);
router.patch("/restaurants/:restaurantId/slug", updateSlug);

module.exports = router;
