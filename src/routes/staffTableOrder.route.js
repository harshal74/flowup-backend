/**
 * Staff dine-in ordering routes.
 *   POST /api/table-orders        -> staff JWT (ADMIN, ASSISTANT, WAITER; CHEF denied)
 *   POST /api/admin/table-orders  -> admin JWT
 */

const express     = require("express");
const staffAuth   = require("../middleware/staffAuth");
const requireRole = require("../middleware/requireRole");
const protect     = require("../middleware/auth.middleware");
const { createStaffDineInOrder } = require("../controllers/staffTableOrder.controller");

const staffRouter = express.Router();
staffRouter.post("/", staffAuth, requireRole("ADMIN", "ASSISTANT", "WAITER"), createStaffDineInOrder);

const adminRouter = express.Router();
adminRouter.post("/", protect, (req, _res, next) => {
  req.staff = {
    _id:          req.user._id,
    restaurantId: req.user.restaurantId,
    name:         req.user.name || req.user.email || "Admin",
    role:         "ADMIN",
  };
  next();
}, createStaffDineInOrder);

module.exports = { staffRouter, adminRouter };
