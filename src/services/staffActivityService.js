const StaffActivity = require("../models/StaffActivity");

/**
 * Log a staff action asynchronously — never throws, never blocks the caller.
 *
 * @param {object} params
 * @param {object} params.staff     - The authenticated staff member (req.staff)
 * @param {string} params.action    - Human-readable action label e.g. "Accepted Order"
 * @param {string} params.entityType - "Order" | "Bill" | "WaiterRequest" etc.
 * @param {*}      params.entityId  - MongoDB ObjectId of the affected document
 * @param {string} [params.oldValue] - Status/value before the change
 * @param {string} [params.newValue] - Status/value after the change
 * @param {object} [params.req]     - Express request object (for IP + UA capture)
 */
async function logActivity({
  staff,
  action,
  entityType = "",
  entityId = null,
  oldValue = "",
  newValue = "",
  req = null,
}) {
  try {
    await StaffActivity.create({
      restaurantId: staff.restaurantId,
      staffId:      staff._id,
      staffName:    staff.name,
      role:         staff.role,
      action,
      entityType,
      entityId:     entityId || null,
      oldValue:     String(oldValue || ""),
      newValue:     String(newValue || ""),
      ipAddress:    req ? (req.ip || req.headers["x-forwarded-for"] || "") : "",
      userAgent:    req ? (req.headers["user-agent"] || "") : "",
      timestamp:    new Date(),
    });
  } catch (err) {
    // Silently discard — logging must never fail a primary action
    console.error("[StaffActivity] Failed to log activity:", err.message);
  }
}

module.exports = { logActivity };
