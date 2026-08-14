/**
 * Admin Staff Management Routes
 * All routes require admin authentication (protect middleware).
 * Mounted at: /api/admin/staff
 */

const express = require("express");
const router  = express.Router();
const protect = require("../middleware/auth.middleware");
const ctrl    = require("../controllers/adminStaff.controller");

// All routes require admin auth
router.use(protect);

router.get("/",                      ctrl.getStaff);
router.get("/:id",                   ctrl.getStaffById);
router.post("/",                     ctrl.createStaff);
router.patch("/:id",                 ctrl.updateStaff);
router.patch("/:id/block",           ctrl.blockStaff);
router.patch("/:id/unblock",         ctrl.unblockStaff);
router.post("/:id/verify-otp",       ctrl.verifyStaffOtp);
router.post("/:id/resend-otp",       ctrl.resendStaffOtp);
router.get("/:id/activity",          ctrl.getStaffActivity);

module.exports = router;
