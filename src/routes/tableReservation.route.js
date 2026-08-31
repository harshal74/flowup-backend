/**
 * Table Reservation Routes — V2
 *
 * Authorization:
 *   GET  → authenticated staff (ADMIN, ASSISTANT, WAITER, CHEF)
 *   POST, PATCH, DELETE, status transitions → ADMIN + ASSISTANT only
 */

const express     = require("express");
const staffAuth   = require("../middleware/staffAuth");
const requireRole = require("../middleware/requireRole");
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

// All routes: authenticated staff only
router.use(staffAuth);

// GET — read access for all authenticated staff
router.get("/",    listReservations);
router.get("/:id", getReservationById);

// Mutation — ADMIN + ASSISTANT only; WAITER gets 403
router.post(   "/",                requireRole("ADMIN", "ASSISTANT"), createReservation);
router.patch(  "/:id",             requireRole("ADMIN", "ASSISTANT"), updateReservation);
router.delete( "/:id",             requireRole("ADMIN", "ASSISTANT"), cancelReservation);

// Status transitions — ADMIN + ASSISTANT only
router.patch("/:id/arrive",   requireRole("ADMIN", "ASSISTANT"), markArrived);
router.patch("/:id/complete", requireRole("ADMIN", "ASSISTANT"), markCompleted);
router.patch("/:id/no-show",  requireRole("ADMIN", "ASSISTANT"), markNoShow);

module.exports = router;
