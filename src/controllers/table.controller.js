/**
 * Tables + QR codes.
 *
 *   GET  /api/tables                              admin — list tables with qrTokens
 *   POST /api/tables/:tableNumber/regenerate-qr   admin — new qrToken for a table
 *   POST /api/public/tables/resolve               public — qrToken → guest table JWT
 */

const Setting = require("../models/Setting");
const Table = require("../models/Table");
const {
  GUEST_TOKEN_TTL_MS,
  ensureTablesForRestaurant,
  regenerateTableQr,
  signGuestTableToken,
} = require("../services/table.service");

const serialize = (t) => ({
  tableNumber: t.tableNumber,
  qrToken: t.qrToken,
  isActive: t.isActive,
  updatedAt: t.updatedAt,
});

// GET /api/tables
exports.listTables = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const settings = await Setting.findOne({ restaurantId }).select("totalTables").lean();
    await ensureTablesForRestaurant(restaurantId, settings?.totalTables ?? 10);

    const tables = await Table.find({ restaurantId, isActive: true }).sort({ tableNumber: 1 }).lean();
    return res.status(200).json({ success: true, data: tables.map(serialize) });
  } catch (err) {
    console.error("[Tables] list error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to load tables." });
  }
};

// POST /api/tables/:tableNumber/regenerate-qr
exports.regenerateQr = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const tableNumber = Number(req.params.tableNumber);
    if (!Number.isInteger(tableNumber) || tableNumber < 1) {
      return res.status(400).json({ success: false, message: "Invalid table number." });
    }

    const table = await regenerateTableQr(restaurantId, tableNumber);
    if (!table) {
      return res.status(404).json({ success: false, message: "Table not found." });
    }
    return res.status(200).json({
      success: true,
      message: `QR code for table ${tableNumber} regenerated. The old QR code no longer works.`,
      data: serialize(table),
    });
  } catch (err) {
    console.error("[Tables] regenerate error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to regenerate QR code." });
  }
};

// POST /api/public/tables/resolve   body: { qrToken }
exports.resolveTable = async (req, res) => {
  try {
    const raw = req.body?.qrToken ?? req.params?.qrToken;
    const qrToken = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    const invalid = () =>
      res.status(404).json({ success: false, message: "Invalid or inactive table QR code." });

    if (!/^[a-f0-9]{16}$/.test(qrToken)) return invalid();

    const table = await Table.findOne({ qrToken, isActive: true }).lean();
    if (!table) return invalid();

    // Same restaurant checks as resolvePublicRestaurant.
    const settings = await Setting.findOne({ restaurantId: table.restaurantId })
      .select("restaurantId restaurantSlug accountStatus expiresAt")
      .lean();
    if (!settings) return invalid();
    if (settings.accountStatus === "SUSPENDED") {
      return res.status(403).json({ success: false, message: "This restaurant is currently unavailable.", suspended: true });
    }
    if (settings.expiresAt && new Date() >= new Date(settings.expiresAt)) {
      return res.status(403).json({ success: false, message: "This restaurant is currently unavailable.", expired: true });
    }

    const guestToken = signGuestTableToken({
      restaurantId: table.restaurantId,
      tableNumber: table.tableNumber,
      qrToken: table.qrToken,
    });

    return res.status(200).json({
      success: true,
      data: {
        guestToken,
        restaurantId: table.restaurantId,
        tableNumber: table.tableNumber,
        restaurantSlug: settings.restaurantSlug || null,
        expiresAt: new Date(Date.now() + GUEST_TOKEN_TTL_MS).toISOString(),
      },
    });
  } catch (err) {
    console.error("[Tables] resolve error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to read table QR code." });
  }
};
