const express    = require("express");
const router     = express.Router();
const protect    = require("../middleware/auth.middleware");
const staffAuth  = require("../middleware/staffAuth");
const { tryStaffAuthMiddleware } = staffAuth;

const {
  getUnpaidOrders,
  getPendingBills,
  generateBill,
  confirmPayment,
  splitBill,
  confirmSplitPayment,
  cancelBill,
  getBillHistory,
  getBillById,
} = require("../controllers/billing.controller");

/**
 * Accept either an admin JWT (protect) OR a staff JWT (staffAuth).
 * Uses tryStaffAuthMiddleware so it never sends a response itself.
 * If req.staff is set after it runs, we normalise req.user and continue.
 * Otherwise we fall back to admin protect middleware.
 */
function adminOrStaff(req, res, next) {
  tryStaffAuthMiddleware(req, res, () => {
    if (req.staff) {
      req.user = { restaurantId: req.staff.restaurantId, _id: req.staff._id };
      return next();
    }
    protect(req, res, next);
  });
}

/**
 * Billing changes (generate / split / confirm / cancel) are limited to the
 * roles that see Billing in the apps: restaurant admins (admin JWT) and staff
 * with role ADMIN or WAITER. CHEF and ASSISTANT get 403. Read-only routes
 * stay open to any authenticated staff.
 */
const BILLING_STAFF_ROLES = ["ADMIN", "WAITER"];
function requireBillingRole(req, res, next) {
  if (req.staff && !BILLING_STAFF_ROLES.includes(req.staff.role)) {
    return res.status(403).json({ success: false, message: "Only admins and waiters can manage bills." });
  }
  next();
}
const canBill = [adminOrStaff, requireBillingRole];

// Static routes first (before /:billId)
router.get("/orders",   adminOrStaff, getUnpaidOrders);
router.post("/generate", ...canBill, generateBill);
router.get("/history",  adminOrStaff, getBillHistory);
router.get("/pending",  adminOrStaff, getPendingBills); // must stay before /:billId

// Parameterised routes
router.patch("/:billId/confirm",                 ...canBill, confirmPayment);
router.patch("/:billId/split",                   ...canBill, splitBill);
router.patch("/:billId/splits/:splitId/confirm", ...canBill, confirmSplitPayment);
router.delete("/:billId",                        ...canBill, cancelBill);
router.get("/:billId",                           adminOrStaff, getBillById);

module.exports = router;
