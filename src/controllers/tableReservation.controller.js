/**
 * Table Reservation Controller — V2
 *
 * SECURITY:
 * - restaurantId always comes from req.staff.restaurantId (never from body).
 * - All queries scoped by restaurantId (cross-tenant protection).
 * - IDOR: GET/:id, PATCH/:id, DELETE/:id verify restaurantId ownership.
 *
 * Authorization (route middleware):
 *   POST, PATCH, DELETE, status-transitions → ADMIN + ASSISTANT only
 *   GET → all authenticated staff (ADMIN, ASSISTANT, WAITER, CHEF)
 *
 * Conflict detection (time-based):
 *   Two reservations conflict when: existingStart < requestedEnd AND existingEnd > requestedStart.
 *   Only RESERVED and ARRIVED records participate — CANCELLED, COMPLETED, NO_SHOW do not block.
 *   Legacy ACTIVE records are treated as RESERVED.
 *
 * Time handling:
 *   - Frontend sends reservationDate (YYYY-MM-DD IST), startTime and endTime (HH:MM 24h).
 *   - Backend combines these into UTC Date objects using IST offset (+5:30).
 *   - All comparisons are UTC. Frontend formats for display.
 */

const mongoose         = require("mongoose");
const TableReservation = require("../models/TableReservation");
const Setting          = require("../models/Setting");
const { emitToRestaurant } = require("../socket");
const { logActivity }      = require("../services/staffActivityService");
const { isValidMobile, normalizeMobile, MOBILE_ERROR_MESSAGE } = require("../utils/validateMobile");

// IST offset: UTC+5:30 = 330 minutes
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Statuses that actively hold a reservation slot (participate in conflict detection)
const BLOCKING_STATUSES = ["RESERVED", "ACTIVE", "ARRIVED"];

// ── IST date/time helpers ──────────────────────────────────────────

/**
 * Convert a YYYY-MM-DD date string + HH:MM time string (both in IST)
 * to a UTC Date object.
 */
function istToUtc(dateStr, timeStr) {
  // dateStr: "2026-08-30", timeStr: "20:00"
  const [y, m, d]    = dateStr.split("-").map(Number);
  const [hr, min]    = timeStr.split(":").map(Number);
  if (
    isNaN(y) || isNaN(m) || isNaN(d) || isNaN(hr) || isNaN(min) ||
    m < 1 || m > 12 || d < 1 || d > 31 || hr < 0 || hr > 23 || min < 0 || min > 59
  ) {
    return null;
  }
  // Build UTC timestamp: date/time in IST = UTC - 5h30m
  const utcMs = Date.UTC(y, m - 1, d, hr, min, 0, 0) - IST_OFFSET_MS;
  const result = new Date(utcMs);
  return isNaN(result.getTime()) ? null : result;
}

/**
 * Current time as a YYYY-MM-DD string in IST.
 */
function todayISTString() {
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  const y = nowIST.getUTCFullYear();
  const m = String(nowIST.getUTCMonth() + 1).padStart(2, "0");
  const d = String(nowIST.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Current time string HH:MM in IST.
 */
function currentTimeISTString() {
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  const h = String(nowIST.getUTCHours()).padStart(2, "0");
  const m = String(nowIST.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

// ── Validation helpers ─────────────────────────────────────────────

function validateTime(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return false;
  return /^\d{2}:\d{2}$/.test(timeStr.trim());
}

function validateDate(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim());
}

/**
 * Parse + validate the reservation time window from request body.
 * Returns { start, end } as UTC Dates, or an error string.
 */
function parseTimeWindow(reservationDate, startTime, endTime) {
  // Validate format
  if (!validateDate(reservationDate)) return "Reservation date must be in YYYY-MM-DD format.";
  if (!validateTime(startTime))        return "Start time is required (HH:MM format).";
  if (!validateTime(endTime))          return "End time is required (HH:MM format).";

  const start = istToUtc(reservationDate, startTime);
  const end   = istToUtc(reservationDate, endTime);

  if (!start) return "Invalid reservation date or start time.";
  if (!end)   return "Invalid reservation date or end time.";
  if (end <= start) return "End time must be after start time.";

  // Must be in the future (compared to now)
  if (start <= new Date()) {
    return "Reservation date and time must be in the future.";
  }

  return { start, end };
}

// ── Conflict detection ─────────────────────────────────────────────

/**
 * Check for overlapping reservations.
 * Two intervals [A_start, A_end) and [B_start, B_end) overlap when:
 *   A_start < B_end  AND  A_end > B_start
 * Back-to-back (A_end === B_start) is NOT a conflict.
 * Only RESERVED, ACTIVE, and ARRIVED reservations block slots.
 *
 * @param {string}   restaurantId
 * @param {number}   tableNumber
 * @param {Date}     start
 * @param {Date}     end
 * @param {string}   [excludeId]  — reservation ID to exclude (used on update)
 * @returns {boolean} true if conflict exists
 */
async function hasConflict(restaurantId, tableNumber, start, end, excludeId = null) {
  const filter = {
    restaurantId,
    tableNumber,
    status: { $in: BLOCKING_STATUSES },
    reservationStart: { $ne: null }, // skip legacy records with no time
    reservationStart: { $lt: end },
    reservationEnd:   { $gt: start },
  };
  // Override reservationStart filter properly (MongoDB does not allow duplicate keys)
  delete filter.reservationStart;
  filter.reservationStart = { $ne: null, $lt: end };
  filter.reservationEnd   = { $gt: start };

  if (excludeId && mongoose.Types.ObjectId.isValid(excludeId)) {
    filter._id = { $ne: new mongoose.Types.ObjectId(excludeId) };
  }

  const conflict = await TableReservation.findOne(filter).select("_id guestName reservationStart reservationEnd").lean();
  return conflict;
}

// ── Socket emit helper ─────────────────────────────────────────────

function emitReservationEvent(restaurantId, event, reservation) {
  emitToRestaurant(restaurantId, event, {
    _id:              reservation._id.toString(),
    restaurantId:     reservation.restaurantId,
    tableNumber:      reservation.tableNumber,
    guestName:        reservation.guestName,
    mobileNumber:     reservation.mobileNumber || null,
    numberOfPeople:   reservation.numberOfPeople,
    reservationStart: reservation.reservationStart ? reservation.reservationStart.toISOString() : null,
    reservationEnd:   reservation.reservationEnd   ? reservation.reservationEnd.toISOString()   : null,
    notes:            reservation.notes || "",
    reservedByName:   reservation.reservedByName,
    reservedByRole:   reservation.reservedByRole,
    status:           reservation.status,
    createdAt:        reservation.createdAt ? reservation.createdAt.toISOString() : null,
    updatedAt:        reservation.updatedAt ? reservation.updatedAt.toISOString() : null,
  });
}

// ══════════════════════════════════════════════════════════════════
// POST /api/table-reservations
// ══════════════════════════════════════════════════════════════════
exports.createReservation = async (req, res) => {
  try {
    const restaurantId = req.staff.restaurantId;
    const {
      tableNumber,
      guestName,
      mobileNumber,
      numberOfPeople,
      reservationDate,
      startTime,
      endTime,
      notes,
    } = req.body;

    // ── Validate tableNumber ───────────────────────────────────
    const tableNum = Number(tableNumber);
    if (!Number.isInteger(tableNum) || tableNum < 1) {
      return res.status(400).json({ success: false, message: "Table number must be a positive integer." });
    }
    const settings = await Setting.findOne({ restaurantId }).select("totalTables").lean();
    const maxTables = settings?.totalTables || 10;
    if (tableNum > maxTables) {
      return res.status(400).json({ success: false, message: `Table number must be between 1 and ${maxTables}.` });
    }

    // ── Validate guestName ─────────────────────────────────────
    if (!guestName || !String(guestName).trim()) {
      return res.status(400).json({ success: false, message: "Guest name is required." });
    }
    const trimmedName = String(guestName).trim();
    if (trimmedName.length > 120) {
      return res.status(400).json({ success: false, message: "Guest name must be 120 characters or fewer." });
    }

    // ── Validate mobileNumber (optional) ──────────────────────
    let storedMobile = null;
    if (mobileNumber && String(mobileNumber).trim()) {
      if (!isValidMobile(String(mobileNumber).trim())) {
        return res.status(400).json({ success: false, message: MOBILE_ERROR_MESSAGE });
      }
      storedMobile = normalizeMobile(String(mobileNumber).trim());
    }

    // ── Validate numberOfPeople ────────────────────────────────
    const numPeople = Number(numberOfPeople);
    if (!Number.isInteger(numPeople) || numPeople < 1) {
      return res.status(400).json({ success: false, message: "Number of people must be at least 1." });
    }
    if (numPeople > 100) {
      return res.status(400).json({ success: false, message: "Number of people cannot exceed 100." });
    }

    // ── Validate and parse time window ─────────────────────────
    const timeResult = parseTimeWindow(reservationDate, startTime, endTime);
    if (typeof timeResult === "string") {
      return res.status(400).json({ success: false, message: timeResult });
    }
    const { start, end } = timeResult;

    // ── Conflict detection ─────────────────────────────────────
    const conflict = await hasConflict(restaurantId, tableNum, start, end);
    if (conflict) {
      return res.status(409).json({
        success: false,
        message: `Table ${tableNum} is already reserved during this time.`,
      });
    }

    // ── Create reservation ─────────────────────────────────────
    const reservation = await TableReservation.create({
      restaurantId,
      tableNumber:      tableNum,
      guestName:        trimmedName,
      mobileNumber:     storedMobile,
      numberOfPeople:   numPeople,
      reservationStart: start,
      reservationEnd:   end,
      notes:            String(notes || "").trim().slice(0, 500),
      reservedById:     req.staff._id,
      reservedByName:   req.staff.name,
      reservedByRole:   req.staff.role,
      status:           "RESERVED",
    });

    // ── Socket ─────────────────────────────────────────────────
    emitReservationEvent(restaurantId, "table_reservation_created", reservation);

    // ── Audit log ──────────────────────────────────────────────
    logActivity({
      staff:      req.staff,
      action:     "TABLE_RESERVED",
      entityType: "TableReservation",
      entityId:   reservation._id,
      oldValue:   "",
      newValue:   `Table ${tableNum} — ${trimmedName} (${numPeople} ${numPeople === 1 ? "person" : "people"}) on ${reservationDate} ${startTime}–${endTime}`,
      req,
    });

    return res.status(201).json({ success: true, message: "Table reserved successfully.", data: reservation });
  } catch (error) {
    console.error("[TableReservation] createReservation error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ══════════════════════════════════════════════════════════════════
// GET /api/table-reservations
// Supports ?status=RESERVED|ARRIVED|COMPLETED|CANCELLED|NO_SHOW|ALL
// Also ?tableNumber, ?date (YYYY-MM-DD IST)
// ══════════════════════════════════════════════════════════════════
exports.listReservations = async (req, res) => {
  try {
    const restaurantId = req.staff.restaurantId;
    const { status = "ACTIVE", tableNumber, date } = req.query;

    const filter = { restaurantId };

    // Status filter — "ACTIVE" and "ALL" return active + arrived + reserved
    if (status === "ALL") {
      // no status filter
    } else if (status === "ACTIVE" || status === "ACTIVE_ONLY") {
      // Active = RESERVED + ACTIVE(legacy) + ARRIVED
      filter.status = { $in: ["RESERVED", "ACTIVE", "ARRIVED"] };
    } else if (["RESERVED", "ACTIVE", "ARRIVED", "COMPLETED", "CANCELLED", "NO_SHOW"].includes(status)) {
      if (status === "RESERVED") {
        filter.status = { $in: ["RESERVED", "ACTIVE"] }; // include legacy
      } else {
        filter.status = status;
      }
    } else {
      filter.status = { $in: ["RESERVED", "ACTIVE", "ARRIVED"] }; // default
    }

    if (tableNumber) {
      const t = Number(tableNumber);
      if (Number.isInteger(t) && t > 0) filter.tableNumber = t;
    }

    if (date && validateDate(date)) {
      // Filter by IST calendar day — convert to UTC range
      const dayStart = istToUtc(date, "00:00");
      const dayEnd   = istToUtc(date, "23:59");
      if (dayStart && dayEnd) {
        filter.reservationStart = { $gte: dayStart, $lte: dayEnd };
      }
    }

    const reservations = await TableReservation.find(filter)
      .sort({ reservationStart: 1, createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, count: reservations.length, data: reservations });
  } catch (error) {
    console.error("[TableReservation] listReservations error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ══════════════════════════════════════════════════════════════════
// GET /api/table-reservations/:id
// ══════════════════════════════════════════════════════════════════
exports.getReservationById = async (req, res) => {
  try {
    const restaurantId = req.staff.restaurantId;
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid reservation ID." });
    }

    const reservation = await TableReservation.findOne({ _id: id, restaurantId }).lean();
    if (!reservation) {
      return res.status(404).json({ success: false, message: "Reservation not found." });
    }

    return res.status(200).json({ success: true, data: reservation });
  } catch (error) {
    console.error("[TableReservation] getReservationById error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ══════════════════════════════════════════════════════════════════
// PATCH /api/table-reservations/:id
// Update guest info and/or time window.
// ══════════════════════════════════════════════════════════════════
exports.updateReservation = async (req, res) => {
  try {
    const restaurantId = req.staff.restaurantId;
    const { id }       = req.params;
    const {
      guestName,
      mobileNumber,
      numberOfPeople,
      reservationDate,
      startTime,
      endTime,
      notes,
    } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid reservation ID." });
    }

    const reservation = await TableReservation.findOne({ _id: id, restaurantId });
    if (!reservation) {
      return res.status(404).json({ success: false, message: "Reservation not found." });
    }

    // Only editable when RESERVED or ACTIVE (legacy)
    const editableStatuses = ["RESERVED", "ACTIVE"];
    if (!editableStatuses.includes(reservation.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot edit a reservation with status "${reservation.status}". Only RESERVED reservations can be edited.`,
      });
    }

    const updates = {};

    if (guestName !== undefined) {
      const trimmed = String(guestName).trim();
      if (!trimmed) return res.status(400).json({ success: false, message: "Guest name is required." });
      if (trimmed.length > 120) return res.status(400).json({ success: false, message: "Guest name must be 120 characters or fewer." });
      updates.guestName = trimmed;
    }

    if (mobileNumber !== undefined) {
      if (mobileNumber === null || String(mobileNumber).trim() === "") {
        updates.mobileNumber = null;
      } else {
        const m = String(mobileNumber).trim();
        if (!isValidMobile(m)) return res.status(400).json({ success: false, message: MOBILE_ERROR_MESSAGE });
        updates.mobileNumber = normalizeMobile(m);
      }
    }

    if (numberOfPeople !== undefined) {
      const n = Number(numberOfPeople);
      if (!Number.isInteger(n) || n < 1) return res.status(400).json({ success: false, message: "Number of people must be at least 1." });
      if (n > 100) return res.status(400).json({ success: false, message: "Number of people cannot exceed 100." });
      updates.numberOfPeople = n;
    }

    if (notes !== undefined) {
      updates.notes = String(notes).trim().slice(0, 500);
    }

    // Time window update
    if (reservationDate || startTime || endTime) {
      // All three required if any is provided
      if (!reservationDate || !startTime || !endTime) {
        return res.status(400).json({ success: false, message: "Provide reservationDate, startTime, and endTime together." });
      }
      const timeResult = parseTimeWindow(reservationDate, startTime, endTime);
      if (typeof timeResult === "string") {
        return res.status(400).json({ success: false, message: timeResult });
      }
      const { start, end } = timeResult;

      // Conflict check — exclude this reservation from the check
      const conflict = await hasConflict(restaurantId, reservation.tableNumber, start, end, id);
      if (conflict) {
        return res.status(409).json({
          success: false,
          message: `Table ${reservation.tableNumber} is already reserved during this time.`,
        });
      }

      updates.reservationStart = start;
      updates.reservationEnd   = end;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: "Provide at least one field to update." });
    }

    Object.assign(reservation, updates);
    await reservation.save();

    emitReservationEvent(restaurantId, "table_reservation_updated", reservation);

    logActivity({
      staff:      req.staff,
      action:     "TABLE_RESERVATION_UPDATED",
      entityType: "TableReservation",
      entityId:   reservation._id,
      oldValue:   "",
      newValue:   `Table ${reservation.tableNumber} — ${reservation.guestName} (${reservation.numberOfPeople} ${reservation.numberOfPeople === 1 ? "person" : "people"})`,
      req,
    });

    return res.status(200).json({ success: true, message: "Reservation updated.", data: reservation });
  } catch (error) {
    console.error("[TableReservation] updateReservation error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ══════════════════════════════════════════════════════════════════
// DELETE /api/table-reservations/:id — Cancel (soft delete)
// ══════════════════════════════════════════════════════════════════
exports.cancelReservation = async (req, res) => {
  try {
    const restaurantId = req.staff.restaurantId;
    const { id }       = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid reservation ID." });
    }

    const reservation = await TableReservation.findOne({ _id: id, restaurantId });
    if (!reservation) {
      return res.status(404).json({ success: false, message: "Reservation not found." });
    }
    if (["CANCELLED", "COMPLETED", "NO_SHOW"].includes(reservation.status)) {
      return res.status(400).json({ success: false, message: `Reservation is already ${reservation.status.toLowerCase()}.` });
    }

    reservation.status = "CANCELLED";
    await reservation.save();

    emitReservationEvent(restaurantId, "table_reservation_cancelled", reservation);

    logActivity({
      staff:      req.staff,
      action:     "TABLE_RESERVATION_CANCELLED",
      entityType: "TableReservation",
      entityId:   reservation._id,
      oldValue:   `Table ${reservation.tableNumber} — ${reservation.guestName}`,
      newValue:   "CANCELLED",
      req,
    });

    return res.status(200).json({ success: true, message: "Reservation cancelled.", data: reservation });
  } catch (error) {
    console.error("[TableReservation] cancelReservation error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ══════════════════════════════════════════════════════════════════
// PATCH /api/table-reservations/:id/arrive — Mark Arrived
// RESERVED → ARRIVED
// ══════════════════════════════════════════════════════════════════
exports.markArrived = async (req, res) => {
  try {
    const restaurantId = req.staff.restaurantId;
    const { id }       = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid reservation ID." });
    }

    const reservation = await TableReservation.findOne({ _id: id, restaurantId });
    if (!reservation) {
      return res.status(404).json({ success: false, message: "Reservation not found." });
    }

    if (!["RESERVED", "ACTIVE"].includes(reservation.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot mark arrived — reservation is in "${reservation.status}" status.`,
      });
    }

    reservation.status = "ARRIVED";
    await reservation.save();

    emitReservationEvent(restaurantId, "table_reservation_updated", reservation);

    logActivity({
      staff:      req.staff,
      action:     "TABLE_RESERVATION_ARRIVED",
      entityType: "TableReservation",
      entityId:   reservation._id,
      oldValue:   "RESERVED",
      newValue:   "ARRIVED",
      req,
    });

    return res.status(200).json({ success: true, message: "Guest marked as arrived.", data: reservation });
  } catch (error) {
    console.error("[TableReservation] markArrived error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ══════════════════════════════════════════════════════════════════
// PATCH /api/table-reservations/:id/complete — Mark Completed
// ARRIVED → COMPLETED (also allows RESERVED → COMPLETED for edge cases)
// ══════════════════════════════════════════════════════════════════
exports.markCompleted = async (req, res) => {
  try {
    const restaurantId = req.staff.restaurantId;
    const { id }       = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid reservation ID." });
    }

    const reservation = await TableReservation.findOne({ _id: id, restaurantId });
    if (!reservation) {
      return res.status(404).json({ success: false, message: "Reservation not found." });
    }

    if (!["RESERVED", "ACTIVE", "ARRIVED"].includes(reservation.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot mark completed — reservation is in "${reservation.status}" status.`,
      });
    }

    reservation.status = "COMPLETED";
    await reservation.save();

    emitReservationEvent(restaurantId, "table_reservation_updated", reservation);

    logActivity({
      staff:      req.staff,
      action:     "TABLE_RESERVATION_COMPLETED",
      entityType: "TableReservation",
      entityId:   reservation._id,
      oldValue:   "ARRIVED",
      newValue:   "COMPLETED",
      req,
    });

    return res.status(200).json({ success: true, message: "Reservation marked completed.", data: reservation });
  } catch (error) {
    console.error("[TableReservation] markCompleted error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ══════════════════════════════════════════════════════════════════
// PATCH /api/table-reservations/:id/no-show — Mark No Show
// RESERVED → NO_SHOW
// ══════════════════════════════════════════════════════════════════
exports.markNoShow = async (req, res) => {
  try {
    const restaurantId = req.staff.restaurantId;
    const { id }       = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid reservation ID." });
    }

    const reservation = await TableReservation.findOne({ _id: id, restaurantId });
    if (!reservation) {
      return res.status(404).json({ success: false, message: "Reservation not found." });
    }

    if (!["RESERVED", "ACTIVE"].includes(reservation.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot mark no-show — reservation is in "${reservation.status}" status.`,
      });
    }

    reservation.status = "NO_SHOW";
    await reservation.save();

    emitReservationEvent(restaurantId, "table_reservation_updated", reservation);

    logActivity({
      staff:      req.staff,
      action:     "TABLE_RESERVATION_NO_SHOW",
      entityType: "TableReservation",
      entityId:   reservation._id,
      oldValue:   "RESERVED",
      newValue:   "NO_SHOW",
      req,
    });

    return res.status(200).json({ success: true, message: "Reservation marked as no-show.", data: reservation });
  } catch (error) {
    console.error("[TableReservation] markNoShow error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};
