/**
 * TableReservation — V2
 *
 * Key design decisions:
 * - Stores reservation as a time window: reservationStart + reservationEnd (UTC Date).
 *   Frontend sends IST date/time strings; backend converts to UTC for storage.
 * - Status lifecycle: RESERVED → ARRIVED → COMPLETED
 *                     RESERVED → CANCELLED
 *                     RESERVED → NO_SHOW
 * - The V1 partial unique index on (restaurantId, tableNumber) for ACTIVE status
 *   is REMOVED. Time-based conflict detection replaces it (a table can have
 *   multiple non-overlapping future reservations).
 * - Backward compatibility: old records had status "ACTIVE". These are treated
 *   as "RESERVED" by the controller. The enum includes both for safety.
 * - mobileNumber stored as normalized 10-digit string (Indian mobile convention).
 * - NEVER store passwords, JWTs, OTPs, tokens, or secrets.
 */

const mongoose = require("mongoose");

const tableReservationSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    tableNumber: {
      type: Number,
      required: true,
      min: 1,
    },

    guestName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },

    mobileNumber: {
      type: String,
      default: null,
      trim: true,
      maxlength: 20,
    },

    numberOfPeople: {
      type: Number,
      required: true,
      min: 1,
      max: 100,
    },

    // Reservation window — stored in UTC, displayed in IST by the frontend.
    // Both are required for new reservations; null on legacy records.
    reservationStart: {
      type: Date,
      default: null,
      index: true,
    },

    reservationEnd: {
      type: Date,
      default: null,
    },

    notes: {
      type: String,
      default: "",
      trim: true,
      maxlength: 500,
    },

    // Identity of the staff member who created this reservation
    reservedById: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },

    reservedByName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    reservedByRole: {
      type: String,
      enum: ["ADMIN", "ASSISTANT"],
      required: true,
    },

    status: {
      type: String,
      // ACTIVE kept for V1 backward compatibility — treated as RESERVED by controllers
      enum: ["ACTIVE", "RESERVED", "ARRIVED", "COMPLETED", "CANCELLED", "NO_SHOW"],
      default: "RESERVED",
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// ── Indexes ───────────────────────────────────────────────────────

// Main table-page query: all active reservations for a restaurant
tableReservationSchema.index({ restaurantId: 1, status: 1 });

// Time-conflict detection query
tableReservationSchema.index({ restaurantId: 1, tableNumber: 1, reservationStart: 1, status: 1 });

// History queries
tableReservationSchema.index({ restaurantId: 1, createdAt: -1 });

module.exports =
  mongoose.models.TableReservation ||
  mongoose.model("TableReservation", tableReservationSchema);
