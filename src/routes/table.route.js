/**
 * Table routes.
 *   /api/tables         admin JWT
 *   /api/public/tables  public (rate limited)
 */

const express = require("express");
const protect = require("../middleware/auth.middleware");
const { rateLimit } = require("../middleware/rateLimit");
const ctrl = require("../controllers/table.controller");

const adminRouter = express.Router();
adminRouter.get("/", protect, ctrl.listTables);
adminRouter.post("/:tableNumber/regenerate-qr", protect, ctrl.regenerateQr);

// 30 scans/min per IP is generous for a table full of guests and makes
// guessing 64-bit tokens pointless.
const resolveLimiter = rateLimit({
  windowMs: 60000,
  max: 30,
  message: "Too many QR scans. Please wait a moment and try again.",
});

const publicRouter = express.Router();
publicRouter.post("/resolve", resolveLimiter, ctrl.resolveTable);
publicRouter.get("/resolve/:qrToken", resolveLimiter, ctrl.resolveTable);

module.exports = { adminRouter, publicRouter };
