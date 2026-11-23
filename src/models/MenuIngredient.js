const mongoose = require("mongoose");

/**
 * MenuIngredient — recipe/BOM mapping (Inventory Step 2).
 *
 * One document = "menu item X consumes `quantityPerItem` (in baseUnit) of raw
 * material Y for ONE unit of X". A future deduction step multiplies by the
 * ordered quantity. Kept as a SEPARATE collection (not embedded in Menu) so:
 *   • recipes change independently of the customer-facing Menu hot path,
 *   • a raw material can be referenced by many menu items (many-to-many),
 *   • Menu documents stay lean.
 *
 * Scope (Step 2 ONLY): CRUD of recipe mappings. NO order-completion deduction,
 * NO low-stock notifications, NO InventoryTransaction/history.
 *
 * Tenancy: restaurantId is ALWAYS set from the authenticated user server-side.
 * The controller additionally verifies menuId and rawMaterialId both belong to
 * that restaurant before creating a mapping (no cross-restaurant references).
 *
 * Conventions follow existing FlowUp models (String restaurantId, ObjectId
 * refs, timestamps).
 */

const menuIngredientSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    menuId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Menu",
      required: true,
      index: true,
    },

    rawMaterialId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RawMaterial",
      required: true,
      index: true,
    },

    // Amount of the raw material consumed for ONE unit of the menu item,
    // expressed in the raw material's baseUnit (Step 1 base-unit strategy).
    // Must be strictly > 0.
    quantityPerItem: {
      type: Number,
      required: true,
      min: [0.000001, "quantityPerItem must be greater than 0"],
      validate: {
        validator: (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
        message: "quantityPerItem must be a number greater than 0",
      },
    },

    // Snapshot of the raw material's baseUnit at mapping time (display + future
    // deduction convenience). The authoritative unit remains on RawMaterial.
    baseUnit: {
      type: String,
      required: true,
      trim: true,
    },
  },
  {
    timestamps: true, // createdAt / updatedAt
  }
);

// ── Indexes ────────────────────────────────────────────────────────
// (1) Fetch a menu item's full recipe.
menuIngredientSchema.index({ restaurantId: 1, menuId: 1 });

// (2) Reverse lookup: which menu items use a given raw material (future steps).
menuIngredientSchema.index({ restaurantId: 1, rawMaterialId: 1 });

// (3) Prevent duplicate raw-material mapping for the same menu item within a
//     restaurant. Unique compound index is the authoritative guard (the
//     controller also checks, but this makes duplicates impossible under races).
menuIngredientSchema.index(
  { restaurantId: 1, menuId: 1, rawMaterialId: 1 },
  { unique: true }
);

module.exports =
  mongoose.models.MenuIngredient ||
  mongoose.model("MenuIngredient", menuIngredientSchema);
