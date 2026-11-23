const mongoose = require("mongoose");

/**
 * RawMaterial — a restaurant's inventory raw material / stock item (Inventory Step 1).
 *
 * Scope (Step 1 — Raw Material Management ONLY):
 *   • CRUD + stock adjustment for raw materials, tenant-scoped by restaurantId.
 *   • NO recipes, NO automatic order-completion deduction, NO low-stock
 *     notifications, NO Socket.IO events — those are later steps.
 *
 * Conventions follow existing FlowUp models (Category/Menu):
 *   • restaurantId is a String (matches Setting/Order/Menu/Category), required, indexed.
 *   • timestamps: true supplies createdAt/updatedAt.
 *   • Soft-deactivation via isActive (mirrors Category.isActive).
 *
 * Quantity normalization (per approved plan):
 *   • `unit` is the human/display unit (kg, g, litre, ml, piece, packet, …).
 *   • `baseUnit` is the canonical unit that currentQuantity/minimumQuantity are
 *     STORED in (e.g. g, ml, piece). Storing in a base unit avoids kg-vs-g and
 *     litre-vs-ml ambiguity for future recipe/deduction steps. Step 1 stores the
 *     values as provided by the caller; conversion helpers live in later steps.
 */

// Display units a restaurant may pick from. baseUnit is the canonical family.
const UNITS = ["kg", "g", "litre", "ml", "piece", "packet"];
const BASE_UNITS = ["g", "ml", "piece"];

const rawMaterialSchema = new mongoose.Schema(
  {
    // Tenant key — matches the String restaurantId used across FlowUp.
    restaurantId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    // Human/display unit chosen by the restaurant.
    unit: {
      type: String,
      required: true,
      trim: true,
      enum: UNITS,
    },

    // Canonical storage unit for currentQuantity/minimumQuantity.
    baseUnit: {
      type: String,
      required: true,
      trim: true,
      enum: BASE_UNITS,
    },

    // Current stock on hand, expressed in baseUnit. Never negative.
    currentQuantity: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },

    // Low-stock threshold, expressed in baseUnit. Used by a later step; stored now.
    minimumQuantity: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },

    // Purchase/cost price per baseUnit (or per stocking unit — restaurant's choice).
    // Nullable-friendly: defaults to 0 when not supplied.
    purchasePrice: {
      type: Number,
      min: 0,
      default: 0,
    },

    // Optional free-text supplier/details (architecture already supports strings).
    supplier: {
      type: String,
      trim: true,
      maxlength: 200,
      default: "",
    },

    // Soft-deactivation (mirrors Category.isActive) — never hard-delete by default.
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    // ── Low-stock alert state (Step 4) ─────────────────────────────
    // Crossing-based deduplication flag. Set true when currentQuantity crosses
    // to <= minimumQuantity (a fresh LOW_STOCK alert is emitted at that moment),
    // and cleared back to false only when the material recovers ABOVE the
    // threshold. This prevents repeat alerts on every subsequent deduction while
    // the material stays low, and re-arms a new alert after recovery. Default
    // false; legacy documents (undefined) are treated as not-currently-alerting.
    alertActive: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true, // createdAt / updatedAt
  }
);

// ── Indexes ────────────────────────────────────────────────────────
// (1) List a restaurant's materials, newest first (inventory list view).
rawMaterialSchema.index({ restaurantId: 1, createdAt: -1 });

// (2) Fast name lookup / duplicate checks within a restaurant.
rawMaterialSchema.index({ restaurantId: 1, name: 1 });

// (3) Active-material filtering per restaurant.
rawMaterialSchema.index({ restaurantId: 1, isActive: 1 });

module.exports =
  mongoose.models.RawMaterial ||
  mongoose.model("RawMaterial", rawMaterialSchema);

// Exported for controller validation reuse (no secrets; pure enums).
module.exports.UNITS = UNITS;
module.exports.BASE_UNITS = BASE_UNITS;
