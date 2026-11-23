/**
 * Table cleaning routes.
 *   /api/table-cleaning        -> staff JWT (ADMIN, ASSISTANT, WAITER; CHEF denied)
 *   /api/admin/table-cleaning  -> admin JWT (bridged to the staff shape)
 */

const express     = require("express");
const staffAuth   = require("../middleware/staffAuth");
const requireRole = require("../middleware/requireRole");
const protect     = require("../middleware/auth.middleware");
const ctrl        = require("../controllers/tableClean.controller");

function mount(router) {
  router.get("/",              ctrl.listActive);
  router.get("/history",       ctrl.listHistory);
  router.patch("/:id/start",    ctrl.startCleaning);
  router.patch("/:id/complete", ctrl.completeCleaning);
  return router;
}

const staffRouter = express.Router();
staffRouter.use(staffAuth, requireRole("ADMIN", "ASSISTANT", "WAITER"));
mount(staffRouter);

const adminRouter = express.Router();
adminRouter.use(protect, (req, _res, next) => {
  req.staff = {
    _id:          req.user._id,
    restaurantId: req.user.restaurantId,
    name:         req.user.name || req.user.email || "Admin",
    role:         "ADMIN",
  };
  next();
});
mount(adminRouter);

module.exports = { staffRouter, adminRouter };
