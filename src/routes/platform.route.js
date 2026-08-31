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
  setExpiry,
  resetAdminPassword,
} = require("../controllers/platform.controller");
const {
  getLoginActivity,
  getLoginActivitySummary,
} = require("../controllers/loginActivity.controller");
const {
  getFinanceSummary,
  getTransactions,
  addRevenue,
  addInvestment,
  addExpense,
  updateTransaction,
  deleteTransaction,
  getRestaurantFinanceOverview,
  updateSubscriptionAmount,
} = require("../controllers/platformFinance.controller");

const router = express.Router();

// All platform routes require SUPER_ADMIN authentication
router.use(platformAuth);

// Summary / dashboard
router.get("/summary", getPlatformSummary);
router.get("/audit-logs", getAuditLogs);

// Login Activity — SUPER_ADMIN only (platformAuth enforces)
router.get("/login-activity",         getLoginActivity);
router.get("/login-activity/summary", getLoginActivitySummary);

// Restaurant CRUD
router.get("/restaurants", listRestaurants);
router.post("/restaurants", createRestaurant);
router.get("/restaurants/:restaurantId", getRestaurantDetail);
router.get("/restaurants/:restaurantId/stats", getRestaurantStats);

// Restaurant status management
router.patch("/restaurants/:restaurantId/suspend",      suspendRestaurant);
router.patch("/restaurants/:restaurantId/reactivate",   reactivateRestaurant);
router.patch("/restaurants/:restaurantId/slug",         updateSlug);
router.patch("/restaurants/:restaurantId/expiry",       setExpiry);
router.patch("/restaurants/:restaurantId/subscription", updateSubscriptionAmount);
router.patch("/restaurants/:restaurantId/admin/reset-password", resetAdminPassword);

// Finance — platform money management (SUPER_ADMIN only)
router.get("/finance/summary",                  getFinanceSummary);
router.get("/finance/transactions",             getTransactions);
router.post("/finance/revenue",                 addRevenue);
router.post("/finance/investment",              addInvestment);
router.post("/finance/expense",                 addExpense);
router.patch("/finance/transactions/:id",       updateTransaction);
router.delete("/finance/transactions/:id",      deleteTransaction);
router.get("/finance/restaurants",              getRestaurantFinanceOverview);

module.exports = router;
