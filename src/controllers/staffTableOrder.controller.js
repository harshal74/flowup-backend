/**
 * Staff dine-in ordering.
 *
 * POST /  — a staff member places a DINE_IN order for a customer at a table.
 *
 * This is a thin guard in front of the existing createOrder() controller, so
 * pricing, availability, customer handling, idempotency, sockets, WhatsApp and
 * the order lifecycle are exactly the same as for customer orders.
 *
 * Guards (server-side, not trusting the UI):
 *   - restaurantId comes from the authenticated staff, never the body
 *   - tableNumber is an integer within Setting.totalTables
 *   - no unsettled dine-in order on the table
 *   - no active DIRTY / CLEANING record
 *   - no RESERVED reservation whose window covers "now" (ARRIVED is allowed:
 *     those guests are seated and ordering on their behalf is the point)
 *
 * Concurrency: a per-(restaurant, table) in-process lock serialises the
 * check-then-create sequence. Limitation: the lock is per Node process; with
 * several backend instances two requests could still race. The idempotency key
 * (unique index) protects against double-submits from the same client.
 */

const Order = require("../models/Order");
const Setting = require("../models/Setting");
const TableClean = require("../models/TableClean");
const TableReservation = require("../models/TableReservation");
const { createOrder } = require("./order.controller");
const { hasUnsettledOrders } = require("../services/tableClean.service");

const locks = new Set();

async function checkTableEligible(restaurantId, tableNumber) {
  if (await hasUnsettledOrders(restaurantId, tableNumber)) {
    return "This table already has an active order.";
  }

  const clean = await TableClean.findOne({ restaurantId, tableNumber, active: true })
    .select("status")
    .lean();
  if (clean) {
    return clean.status === "CLEANING"
      ? "This table is being cleaned."
      : "This table is dirty and must be cleaned first.";
  }

  const now = new Date();
  const conflict = await TableReservation.exists({
    restaurantId,
    tableNumber,
    status: { $in: ["RESERVED", "ACTIVE"] },
    $or: [
      { reservationStart: null },
      { reservationStart: { $lte: now }, reservationEnd: { $gt: now } },
    ],
  });
  if (conflict) return "This table is reserved right now.";

  return null;
}

exports.createStaffDineInOrder = async (req, res) => {
  const restaurantId = req.staff?.restaurantId;
  if (!restaurantId) {
    return res.status(401).json({ success: false, message: "Unauthorized access" });
  }

  const body = req.body || {};
  const tableNumber = Number(body.tableNumber);
  if (!Number.isInteger(tableNumber) || tableNumber < 1) {
    return res.status(400).json({ success: false, message: "A valid table number is required." });
  }

  const settings = await Setting.findOne({ restaurantId }).select("totalTables").lean();
  const maxTables = settings?.totalTables || 10;
  if (tableNumber > maxTables) {
    return res.status(400).json({
      success: false,
      message: `Table number must be between 1 and ${maxTables}.`,
    });
  }

  // Retry of an order that was already created: let createOrder return it.
  const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  const isRetry = key && (await Order.exists({ restaurantId, idempotencyKey: key }));

  const lockKey = `${restaurantId}:${tableNumber}`;
  if (!isRetry) {
    if (locks.has(lockKey)) {
      return res.status(409).json({
        success: false,
        message: "Another order is being placed for this table. Please try again.",
      });
    }
    locks.add(lockKey);
  }

  try {
    if (!isRetry) {
      const problem = await checkTableEligible(restaurantId, tableNumber);
      if (problem) return res.status(409).json({ success: false, message: problem });
    }

    // Hand over to the existing order pipeline with trusted values only.
    req.restaurantId = restaurantId;
    req.body = {
      orderType: "DINE_IN",
      tableNumber,
      customer: {
        name:   typeof body.customer?.name === "string" ? body.customer.name.trim() : "",
        mobile: body.customer?.mobile,
      },
      items: body.items,
      note: body.note,
      idempotencyKey: key || undefined,
    };
    return await createOrder(req, res);
  } catch (err) {
    console.error("[StaffTableOrder] error:", err.message);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: "Failed to place order." });
    }
  } finally {
    if (!isRetry) locks.delete(lockKey);
  }
};
