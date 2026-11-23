/**
 * FlowUp Inventory — Centralized low-stock alert logic (Step 4).
 *
 * Single source of truth for LOW_STOCK crossing detection + deduplication +
 * persistence + real-time emit. Reused by:
 *   • inventoryDeduction.service.js (order completion, inside its transaction)
 *   • inventory.controller.js (manual stock adjust, minimum-quantity change)
 *
 * Crossing rule (spam-safe):
 *   A new LOW_STOCK notification is created ONLY on the transition
 *     wasLow === false  →  isLow === true      (isLow := newQty <= minQty)
 *   The RawMaterial.alertActive flag persists the "currently alerting" state:
 *     • cross into low  → set alertActive=true  → emit ONE alert
 *     • recover above   → set alertActive=false → re-arm (no alert)
 *     • stay low        → no change, NO new alert
 *   Concurrency-safe: the alertActive flag is flipped with an ATOMIC conditional
 *   update ({ alertActive:false } → true). Only the writer that flips it emits,
 *   so duplicate/concurrent deductions cannot create duplicate alerts.
 *
 * NEVER throws to callers (best-effort); a notification failure must not break
 * inventory deduction or stock adjustment. Tenant-scoped throughout.
 */

const Notification = require("../models/Notification");
const RawMaterial = require("../models/RawMaterial");
const { emitToRestaurant } = require("../socket");

function buildMessage(name, current, minimum, baseUnit) {
  const u = baseUnit || "";
  return `${name} is running low. Current stock: ${current} ${u}. Minimum required: ${minimum} ${u}.`.replace(/\s+\./g, ".");
}

/**
 * Recompute the alert flag for a material and, if it just crossed INTO low,
 * persist + emit a single LOW_STOCK notification. If it recovered above the
 * threshold, clear the flag (re-arm) with no notification.
 *
 * Uses atomic conditional flag flips for dedup. Optionally participates in an
 * existing session (used by the deduction transaction) — but the notification
 * document + emit happen AFTER commit for the deduction path (see caller) to
 * avoid emitting for an aborted transaction.
 *
 * @param {Object} p
 * @param {string} p.restaurantId
 * @param {ObjectId|string} p.rawMaterialId
 * @param {string} p.name
 * @param {number} p.newQuantity   post-change balance (baseUnit)
 * @param {number} p.minimumQuantity (baseUnit)
 * @param {string} [p.baseUnit]
 * @param {number} [p.previousAlertActive]  known prior alertActive (optional)
 * @returns {Promise<{ crossedIntoLow:boolean, recovered:boolean, notification?:object }>}
 */
async function evaluateLowStock({ restaurantId, rawMaterialId, name, newQuantity, minimumQuantity, baseUnit }) {
  const result = { crossedIntoLow: false, recovered: false, notification: null };
  try {
    const isLow = Number(newQuantity) <= Number(minimumQuantity) && Number(minimumQuantity) > 0;

    if (isLow) {
      // Atomically claim the alert: flip alertActive false→true. Only the
      // request that flips it (matchedCount with modifiedCount===1) emits.
      const claim = await RawMaterial.updateOne(
        { _id: rawMaterialId, restaurantId, alertActive: { $ne: true } },
        { $set: { alertActive: true } }
      );
      if (claim.modifiedCount === 1) {
        result.crossedIntoLow = true;
        const notif = await Notification.create({
          restaurantId,
          type: "LOW_STOCK",
          rawMaterialId,
          title: "Low Stock",
          message: buildMessage(name, newQuantity, minimumQuantity, baseUnit),
          read: false,
          metadata: {
            rawMaterialId: String(rawMaterialId),
            currentQuantity: Number(newQuantity),
            minimumQuantity: Number(minimumQuantity),
            baseUnit: baseUnit || null,
            name,
          },
        });
        result.notification = notif;

        // Real-time emit to the restaurant room ONLY (never cross-tenant).
        emitToRestaurant(restaurantId, "low_stock_alert", {
          notificationId: String(notif._id),
          type: "LOW_STOCK",
          rawMaterialId: String(rawMaterialId),
          title: notif.title,
          message: notif.message,
          currentQuantity: Number(newQuantity),
          minimumQuantity: Number(minimumQuantity),
          baseUnit: baseUnit || null,
          createdAt: notif.createdAt,
        });
      }
      // else: already alerting (alertActive already true) → no duplicate.
    } else {
      // Recovered above threshold → clear the flag so a future crossing re-alerts.
      const recover = await RawMaterial.updateOne(
        { _id: rawMaterialId, restaurantId, alertActive: true },
        { $set: { alertActive: false } }
      );
      if (recover.modifiedCount === 1) {
        result.recovered = true;
        // Auto-dismiss: delete all unread LOW_STOCK notifications for this
        // material and emit a socket event so the frontend removes them from
        // the bell panel immediately. Best-effort — never affects stock logic.
        try {
          await Notification.deleteMany({
            restaurantId,
            type: "LOW_STOCK",
            rawMaterialId,
            read: false,
          });
          emitToRestaurant(restaurantId, "low_stock_dismissed", {
            rawMaterialId: String(rawMaterialId),
          });
        } catch (dismissErr) {
          console.error("[Inventory][LowStock] auto-dismiss failed:", dismissErr && dismissErr.message);
        }
      }
    }
  } catch (err) {
    // Best-effort: never break the calling operation.
    console.error("[Inventory][LowStock] evaluate failed:", err && err.message ? err.message : "unknown");
  }
  return result;
}

module.exports = { evaluateLowStock, buildMessage };
