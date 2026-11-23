/**
 * Table cleaning controller.
 * Expects req.staff = { _id, restaurantId, name, role } (staffAuth, or the
 * admin bridge in adminTableClean.route.js). restaurantId is never read from
 * the request body/query.
 */

const mongoose = require("mongoose");
const TableClean = require("../models/TableClean");
const { emitToRestaurant } = require("../socket");
const { serializeClean } = require("../services/tableClean.service");

const staffRef = (staff) => ({
  staffId: staff._id,
  name:    staff.name || staff.email || "Staff",
  role:    staff.role || "",
});

// GET / — active (DIRTY / CLEANING) records
exports.listActive = async (req, res) => {
  try {
    const records = await TableClean.find({ restaurantId: req.staff.restaurantId, active: true })
      .sort({ dirtyAt: 1 })
      .lean();
    return res.status(200).json({ success: true, data: records.map(serializeClean) });
  } catch (err) {
    console.error("[TableClean] list error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to load cleaning records." });
  }
};

// GET /history — latest completed cleanings
exports.listHistory = async (req, res) => {
  try {
    const records = await TableClean.find({ restaurantId: req.staff.restaurantId, status: "CLEAN" })
      .sort({ cleanedAt: -1 })
      .limit(100)
      .lean();
    return res.status(200).json({ success: true, data: records.map(serializeClean) });
  } catch (err) {
    console.error("[TableClean] history error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to load cleaning history." });
  }
};

async function transition(req, res, { from, to, set, conflictMessage }) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid cleaning record id." });
    }
    const restaurantId = req.staff.restaurantId;

    // Atomic compare-and-set: only one concurrent request can win the transition.
    const updated = await TableClean.findOneAndUpdate(
      { _id: id, restaurantId, status: from, active: true },
      { $set: set(req.staff) },
      { new: true }
    );

    if (!updated) {
      const current = await TableClean.findOne({ _id: id, restaurantId }).lean();
      if (!current) {
        return res.status(404).json({ success: false, message: "Cleaning record not found." });
      }
      return res.status(409).json({ success: false, message: conflictMessage(current) });
    }

    const payload = serializeClean(updated);
    emitToRestaurant(restaurantId, "table_clean_updated", payload);
    return res.status(200).json({ success: true, data: payload });
  } catch (err) {
    console.error(`[TableClean] ${to} error:`, err.message);
    return res.status(500).json({ success: false, message: "Failed to update cleaning record." });
  }
}

// PATCH /:id/start
exports.startCleaning = (req, res) =>
  transition(req, res, {
    from: "DIRTY",
    to: "CLEANING",
    set: (staff) => ({
      status: "CLEANING",
      cleaningBy: staffRef(staff),
      cleaningStartedAt: new Date(),
    }),
    conflictMessage: (c) =>
      c.status === "CLEANING"
        ? `Cleaning already started by ${c.cleaningBy?.name || "another staff member"}.`
        : "This table is not waiting to be cleaned.",
  });

// PATCH /:id/complete
exports.completeCleaning = (req, res) =>
  transition(req, res, {
    from: "CLEANING",
    to: "CLEAN",
    set: (staff) => ({
      status: "CLEAN",
      active: false,
      cleanedBy: staffRef(staff),
      cleanedAt: new Date(),
    }),
    conflictMessage: (c) =>
      c.status === "DIRTY"
        ? "Start cleaning before marking the table clean."
        : "This table has already been marked clean.",
  });
