/**
 * Admin Table Reservation Routes — V2
 *
 * Secured by admin JWT (auth.middleware).
 * Bridges req.user (Admin) → req.staff shape for the shared controller.
 */

const express   = require("express");
const protect   = require("../middleware/auth.middleware");
const {
  createReservation,
  listReservations,
  getReservationById,
  updateReservation,
  cancelReservation,
  markArrived,
  markCompleted,
  markNoShow,
} = require("../controllers/tableReservation.controller");

const router = express.Router();

// Authenticate with admin JWT
router.use(protect);

// Bridge: map req.user (admin) → req.staff shape expected by the controller
router.use((req, _res, next) => {
  req.staff = {
    _id:          req.user._id,
    restaurantId: req.user.restaurantId,
    name:         req.user.name || req.user.email || "Admin",
    role:         "ADMIN",
  };
  next();
});

// All operations — admin has full access
router.get("/",    listReservations);
router.get("/:id", getReservationById);
router.post("/",    createReservation);
router.patch("/:id", updateReservation);
router.delete("/:id", cancelReservation);

// Status transitions
router.patch("/:id/arrive",   markArrived);
router.patch("/:id/complete", markCompleted);
router.patch("/:id/no-show",  markNoShow);

module.exports = router;
