/**
 * Table — one document per physical table of a restaurant.
 *
 * qrToken is an opaque random string printed in the table's QR code
 * (/q/<qrToken>). It carries no data: the server looks it up to learn the
 * restaurant and table. Regenerating it immediately invalidates the old
 * sticker and every guest session issued from it.
 *
 * Documents for 1..Setting.totalTables are created by
 * services/table.service.js#ensureTablesForRestaurant. Tables above
 * totalTables are kept (isActive: false) so their tokens are never reused.
 */

const mongoose = require("mongoose");

const tableSchema = new mongoose.Schema(
  {
    restaurantId: { type: String, required: true, trim: true, index: true },
    tableNumber:  { type: Number, required: true, min: 1 },
    qrToken:      { type: String, required: true, unique: true, trim: true },
    isActive:     { type: Boolean, default: true },
  },
  { timestamps: true }
);

tableSchema.index({ restaurantId: 1, tableNumber: 1 }, { unique: true });

module.exports = mongoose.models.Table || mongoose.model("Table", tableSchema);
