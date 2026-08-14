const express    = require("express");
const router     = express.Router();
const protect    = require("../middleware/auth.middleware");
const staffAuth  = require("../middleware/staffAuth");
const { tryStaffAuthMiddleware } = staffAuth;

const {
  getUnpaidOrders,
  generateBill,
  confirmPayment,
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

// Static routes first (before /:billId)
router.get("/orders",   adminOrStaff, getUnpaidOrders);
router.post("/generate", adminOrStaff, generateBill);
router.get("/history",  adminOrStaff, getBillHistory);

// Parameterised routes
router.patch("/:billId/confirm", adminOrStaff, confirmPayment);
router.delete("/:billId",        adminOrStaff, cancelBill);
router.get("/:billId",           adminOrStaff, getBillById);

module.exports = router;
