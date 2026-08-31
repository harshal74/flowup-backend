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

// Staff listing
router.get("/",                      ctrl.getStaff);
router.get("/pending",               ctrl.getPendingRequests);
router.get("/rejected",              ctrl.getRejectedRequests);
router.get("/:id",                   ctrl.getStaffById);

// Staff creation (admin creates directly → ACTIVE)
router.post("/",                     ctrl.createStaff);

// Staff updates
router.patch("/:id",                 ctrl.updateStaff);

// Approval workflow
router.patch("/:id/approve",         ctrl.approveStaff);
router.patch("/:id/reject",          ctrl.rejectStaff);

// Block/unblock
router.patch("/:id/block",           ctrl.blockStaff);
router.patch("/:id/unblock",         ctrl.unblockStaff);

// Password reset (admin → staff only; restaurant-scoped)
router.patch("/:id/reset-password",  ctrl.resetStaffPassword);

// Activity
router.get("/:id/activity",          ctrl.getStaffActivity);

module.exports = router;
