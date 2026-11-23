/**
 * Table cleaning helpers.
 *
 * - serializeClean():       shape sent to clients (REST + socket)
 * - hasUnsettledOrders():   is any dine-in order still using the table?
 * - markTableDirtyIfSettled(): called after a bill is paid
 */

const Order = require("../models/Order");
const TableClean = require("../models/TableClean");
const { emitToRestaurant } = require("../socket");

const ACTIVE_ORDER_STATUSES = ["PENDING", "ACCEPTED", "PREPARING", "READY", "OUT_FOR_DELIVERY"];
const STALE_UNPAID_MS = 24 * 60 * 60 * 1000;

function serializeClean(doc) {
  if (!doc) return null;
  const d = typeof doc.toObject === "function" ? doc.toObject() : doc;
  return {
    _id:               String(d._id),
    restaurantId:      d.restaurantId,
    tableNumber:       d.tableNumber,
    orderId:           d.orderId ? String(d.orderId) : null,
    billId:            d.billId ? String(d.billId) : null,
    status:            d.status,
    active:            !!d.active,
    dirtyAt:           d.dirtyAt || null,
    cleaningBy:        d.cleaningBy || null,
    cleaningStartedAt: d.cleaningStartedAt || null,
    cleanedBy:         d.cleanedBy || null,
    cleanedAt:         d.cleanedAt || null,
    createdAt:         d.createdAt,
    updatedAt:         d.updatedAt,
  };
}

/**
 * True when a dine-in order for this table is still in progress or waiting for
 * payment. Mirrors the frontend "Occupied / Bill Requested" rule (unpaid
 * COMPLETED orders older than 24h are treated as stale and ignored).
 */
async function hasUnsettledOrders(restaurantId, tableNumber, excludeIds = []) {
  const since = new Date(Date.now() - STALE_UNPAID_MS);
  const found = await Order.exists({
    restaurantId,
    orderType: "DINE_IN",
    tableNumber,
    ...(excludeIds.length ? { _id: { $nin: excludeIds } } : {}),
    $or: [
      { status: { $in: ACTIVE_ORDER_STATUSES } },
      { status: "COMPLETED", paymentStatus: "PENDING", createdAt: { $gte: since } },
    ],
  });
  return !!found;
}

/**
 * Create the DIRTY record for a table once its dine-in order(s) are completed
 * AND paid and nothing else is still using the table. Idempotent: the partial
 * unique index plus upsert guarantee a single active record. Never throws.
 *
 * @returns {Promise<object|null>} the active record, or null if not applicable
 */
async function markTableDirtyIfSettled({ restaurantId, tableNumber, orderIds = [], billId = null }) {
  try {
    if (!restaurantId || tableNumber == null) return null;

    const orders = await Order.find({ _id: { $in: orderIds }, restaurantId })
      .select("_id orderType tableNumber status paymentStatus")
      .lean();

    // Every order on the bill must be a completed + paid DINE_IN order for this table.
    if (
      orders.length === 0 ||
      orders.length !== orderIds.length ||
      !orders.every(o =>
        o.orderType === "DINE_IN" &&
        o.tableNumber === tableNumber &&
        o.status === "COMPLETED" &&
        o.paymentStatus === "PAID")
    ) {
      return null;
    }

    if (await hasUnsettledOrders(restaurantId, tableNumber, orderIds)) return null;

    let record;
    try {
      record = await TableClean.findOneAndUpdate(
        { restaurantId, tableNumber, active: true },
        {
          $setOnInsert: {
            restaurantId,
            tableNumber,
            orderId: orders[orders.length - 1]._id,
            billId,
            status: "DIRTY",
            active: true,
            dirtyAt: new Date(),
          },
        },
        { upsert: true, new: true }
      );
    } catch (err) {
      if (err && err.code === 11000) {
        // Concurrent request created it first — read the winner.
        record = await TableClean.findOne({ restaurantId, tableNumber, active: true });
      } else {
        throw err;
      }
    }

    if (record) emitToRestaurant(restaurantId, "table_clean_updated", serializeClean(record));
    return record;
  } catch (err) {
    console.error("[TableClean] markTableDirtyIfSettled failed:", err.message);
    return null;
  }
}

module.exports = { serializeClean, hasUnsettledOrders, markTableDirtyIfSettled, ACTIVE_ORDER_STATUSES };
