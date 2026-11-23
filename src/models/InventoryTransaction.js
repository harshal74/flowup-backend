const mongoose = require("mongoose");

/**
 * InventoryTransaction — append-only inventory history/audit (Inventory Step 3).
 *
 * One record per raw-material movement. Step 3 writes DEDUCTION records (with
 * shortage info when stock was insufficient) as part of the order-completion
 * deduction transaction. Records are NEVER updated or deleted.
 *
 * Note: this model is created as part of Step 3 (it is a Step-3 component per
 * the approved plan, not a pre-existing dependency). PURCHASE/ADJUSTMENT types
 * are included in the enum for forward use but Step 3 only writes DEDUCTION.
 *
 * Conventions follow existing FlowUp models (String restaurantId, ObjectId
 * refs, timestamps, uppercase enums).
 */

const inventoryTransactionSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    rawMaterialId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RawMaterial",
      required: true,
      index: true,
    },

    // Movement type. Step 3 writes DEDUCTION only.
    type: {
      type: String,
      enum: ["DEDUCTION", "PURCHASE", "ADJUSTMENT"],
      required: true,
    },

    // Signed change applied to currentQuantity, in the material's baseUnit.
    // For DEDUCTION this is the amount actually removed (<= 0), i.e. the
    // clamped amount (never more than what was in stock).
    quantityDelta: {
      type: Number,
      required: true,
    },

    // Stock balance AFTER this movement, in baseUnit (>= 0).
    balanceAfter: {
      type: Number,
      required: true,
      min: 0,
    },

    // Base unit snapshot for clarity/reporting.
    baseUnit: {
      type: String,
      trim: true,
      default: null,
    },

    // Relation to the order that caused a DEDUCTION (null for other types).
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
      index: true,
    },

    // Free-text origin, e.g. "ORDER_COMPLETION".
    source: {
      type: String,
      trim: true,
      default: null,
    },

    // Shortage info (Option C): when the required amount exceeded available
    // stock, `shortage` is the unmet amount (> 0) and stock was clamped to 0.
    shortage: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Amount that was REQUIRED before clamping (for reconciliation/reporting).
    requiredQuantity: {
      type: Number,
      default: null,
    },

    // Historical unit cost (Financials, Option B): the RawMaterial.purchasePrice
    // per baseUnit captured at the moment of a DEDUCTION, so historical COGS
    // stays accurate even after the material's purchasePrice later changes.
    // OPTIONAL/nullable and backward-compatible: legacy DEDUCTION records (and
    // PURCHASE/ADJUSTMENT rows) leave this null. Never alters quantityDelta,
    // balanceAfter, type, or append-only semantics.
    unitCostSnapshot: {
      type: Number,
      default: null,
      min: 0,
    },
  },
  {
    timestamps: true, // createdAt / updatedAt (append-only; never mutated)
  }
);

// ── Indexes ────────────────────────────────────────────────────────
// (1) History for one raw material, newest first.
inventoryTransactionSchema.index({ restaurantId: 1, rawMaterialId: 1, createdAt: -1 });

// (2) All movements caused by a given order (audit / idempotency inspection).
inventoryTransactionSchema.index({ orderId: 1 });

module.exports =
  mongoose.models.InventoryTransaction ||
  mongoose.model("InventoryTransaction", inventoryTransactionSchema);
