const express = require("express");
const {
  createWaiterRequest,
  getWaiterRequests,
  updateWaiterRequestStatus,
  deleteWaiterRequest,
  deleteAllWaiterRequests,
  resolveTable,
} = require("../controllers/waiterRequest.controller");
const protect    = require("../middleware/auth.middleware");
const staffAuth  = require("../middleware/staffAuth");
const resolvePublicRestaurant = require("../middleware/resolvePublicRestaurant");
const { tryStaffAuthMiddleware } = staffAuth;

/**
 * Accept either admin token (protect) OR staff token (staffAuth).
 * Uses tryStaffAuthMiddleware — never sends a response itself.
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

const router = express.Router();

router.post("/",    resolvePublicRestaurant, createWaiterRequest);  // public — customer (restaurant validated)
router.get("/",     adminOrStaff, getWaiterRequests);                 // admin OR staff
router.patch("/:id/status", adminOrStaff, updateWaiterRequestStatus); // admin OR staff
router.patch("/resolve-table/:tableNumber", adminOrStaff, resolveTable); // admin OR staff — bulk resolve
router.delete("/all", protect, deleteAllWaiterRequests);              // admin only
router.delete("/:id",  adminOrStaff, deleteWaiterRequest);            // admin OR staff

module.exports = router;
