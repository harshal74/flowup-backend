/**
 * Table + QR token service.
 *
 *  - ensureTablesForRestaurant(): create missing Table docs for 1..totalTables,
 *    deactivate tables above totalTables. Never changes an existing qrToken.
 *  - regenerateTableQr():          explicit admin action, new qrToken.
 *  - signGuestTableToken() / verifyGuestTableRequest(): short-lived
 *    GUEST_TABLE JWTs issued when a customer scans a table QR code.
 */

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const Table = require("../models/Table");

const GUEST_TABLE_TYPE = "GUEST_TABLE";
const GUEST_TOKEN_TTL = "2h";
const GUEST_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

const generateQrToken = () => crypto.randomBytes(8).toString("hex");

const isDupKey = (err, field) => err && err.code === 11000 && (!field || err.keyPattern?.[field]);

/** Create one table, retrying on the (astronomically rare) qrToken collision. */
async function createTable(restaurantId, tableNumber) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await Table.create({ restaurantId, tableNumber, qrToken: generateQrToken(), isActive: true });
    } catch (err) {
      if (isDupKey(err, "qrToken")) continue;        // token collision → new token
      if (isDupKey(err)) return null;                // table created concurrently → fine
      throw err;
    }
  }
  throw new Error("Could not generate a unique QR token");
}

/**
 * Make sure Table documents exist for 1..totalTables.
 * Existing qrTokens are never touched.
 */
async function ensureTablesForRestaurant(restaurantId, totalTables) {
  const total = Number(totalTables);
  if (!restaurantId || !Number.isInteger(total) || total < 0) return;

  const existing = await Table.find({ restaurantId }).select("tableNumber").lean();
  const have = new Set(existing.map((t) => t.tableNumber));

  for (let n = 1; n <= total; n++) {
    if (!have.has(n)) await createTable(restaurantId, n);
  }

  // Keep isActive in line with the configured table count.
  await Table.updateMany({ restaurantId, tableNumber: { $gt: total }, isActive: true }, { $set: { isActive: false } });
  await Table.updateMany({ restaurantId, tableNumber: { $lte: total }, isActive: false }, { $set: { isActive: true } });
}

/** Give a table a brand-new qrToken. Returns the updated doc, or null if not found. */
async function regenerateTableQr(restaurantId, tableNumber) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await Table.findOneAndUpdate(
        { restaurantId, tableNumber },
        { $set: { qrToken: generateQrToken() } },
        { returnDocument: "after" }
      );
    } catch (err) {
      if (isDupKey(err, "qrToken")) continue;
      throw err;
    }
  }
  throw new Error("Could not generate a unique QR token");
}

function signGuestTableToken({ restaurantId, tableNumber, qrToken }) {
  return jwt.sign(
    { type: GUEST_TABLE_TYPE, restaurantId, tableNumber, qrToken },
    process.env.JWT_SECRET,
    { expiresIn: GUEST_TOKEN_TTL, algorithm: "HS256" }
  );
}

/** Token from `x-table-session` header, else `Authorization: Bearer`. */
function readGuestToken(req) {
  const header = req.headers["x-table-session"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return null;
}

/**
 * Validate the guest table session on a request.
 * Returns { ok: true, restaurantId, tableNumber } or
 *         { ok: false, status, code, message }.
 */
async function verifyGuestTableRequest(req) {
  const rescan = "Please scan the QR code on your table again.";
  const token = readGuestToken(req);
  if (!token) {
    return { ok: false, status: 401, code: "TABLE_SESSION_REQUIRED", message: `Dine-in orders must be placed from your table's QR code. ${rescan}` };
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
  } catch (err) {
    const expired = err && err.name === "TokenExpiredError";
    return {
      ok: false, status: 401,
      code: expired ? "TABLE_SESSION_EXPIRED" : "TABLE_SESSION_INVALID",
      message: expired ? `Your table session has expired. ${rescan}` : `Your table session is invalid. ${rescan}`,
    };
  }

  if (!decoded || decoded.type !== GUEST_TABLE_TYPE || !decoded.restaurantId ||
      !Number.isInteger(decoded.tableNumber) || !decoded.qrToken) {
    return { ok: false, status: 401, code: "TABLE_SESSION_INVALID", message: `Your table session is invalid. ${rescan}` };
  }

  // The QR must still be the current, active code for that table.
  const table = await Table.exists({
    restaurantId: decoded.restaurantId,
    tableNumber: decoded.tableNumber,
    qrToken: decoded.qrToken,
    isActive: true,
  });
  if (!table) {
    return { ok: false, status: 403, code: "TABLE_SESSION_REVOKED", message: `This table QR code is no longer valid. ${rescan}` };
  }

  return { ok: true, restaurantId: decoded.restaurantId, tableNumber: decoded.tableNumber };
}

/**
 * Reservation holding this table right now (guests not yet arrived).
 * RESERVED (and legacy ACTIVE) whose window covers "now". ARRIVED does not
 * block — those guests are seated. Legacy records without a time window block.
 */
async function findBlockingReservation(restaurantId, tableNumber) {
  const TableReservation = require("../models/TableReservation");
  const now = new Date();
  return TableReservation.findOne({
    restaurantId,
    tableNumber,
    status: { $in: ["RESERVED", "ACTIVE"] },
    $or: [
      { reservationStart: null },
      { reservationStart: { $lte: now }, reservationEnd: { $gt: now } },
    ],
  })
    .select("guestName reservationStart reservationEnd")
    .lean();
}

module.exports = {
  findBlockingReservation,
  GUEST_TABLE_TYPE,
  GUEST_TOKEN_TTL_MS,
  generateQrToken,
  ensureTablesForRestaurant,
  regenerateTableQr,
  signGuestTableToken,
  verifyGuestTableRequest,
};
