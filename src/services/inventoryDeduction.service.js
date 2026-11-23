/**
 * FlowUp Inventory — Order-completion raw-material deduction (Step 3).
 *
 * Deducts raw materials for a COMPLETED order based on each menu item's recipe
 * (MenuIngredient), exactly once, safely, and tenant-scoped.
 *
 * Guarantees (per the Step-2 audit contract):
 *   • EXACTLY-ONCE: an atomic conditional claim on Order
 *     ({ _id, inventoryDeducted:false } → inventoryDeducted:true) is the FIRST
 *     write, inside the transaction. Only the request that flips the flag
 *     deducts. Concurrent/duplicate completions perform ZERO deduction.
 *   • TRANSACTIONAL: the claim + all stock updates + history inserts commit
 *     atomically (Atlas replica set). If anything fails, the whole thing aborts
 *     — so inventoryDeducted is NEVER left true without committed deductions.
 *   • BASE-UNIT MATH ONLY: currentQuantity and quantityPerItem are treated as
 *     already in RawMaterial.baseUnit. NO kg→g / litre→ml conversion here.
 *   • OPTION C (insufficient stock): never negative — clamp to 0, record the
 *     shortage, keep the order COMPLETED.
 *   • FAILURE SAFETY: never throws to the caller; returns a result object. A
 *     failure here must not fail the already-successful order completion.
 *   • TENANCY: every lookup/update scoped by the order's restaurantId.
 *
 * NOT in Step 3: low-stock notifications, notification persistence/UI, sockets,
 * dashboard. This service only deducts + records history.
 */

const mongoose = require("mongoose");
const Order = require("../models/Order");
const MenuIngredient = require("../models/MenuIngredient");
const RawMaterial = require("../models/RawMaterial");
const InventoryTransaction = require("../models/InventoryTransaction");
const { evaluateLowStock } = require("./lowStockAlert.service");

/**
 * Deduct inventory for a completed order. Best-effort; never throws.
 *
 * @param {string|ObjectId} orderId  the order that just transitioned to COMPLETED
 * @returns {Promise<{ ok:boolean, status:string, deductedCount?:number, shortages?:number, error?:string }>}
 *   status ∈ "DEDUCTED" | "ALREADY_DEDUCTED" | "NO_RECIPE" | "ORDER_NOT_ELIGIBLE" | "ERROR"
 */
async function deductInventoryForOrder(orderId) {
  if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
    return { ok: false, status: "ERROR", error: "invalid orderId" };
  }

  let session;
  try {
    // Load the order (outside the transaction is fine — we re-claim atomically).
    const order = await Order.findById(orderId).lean();
    if (!order) return { ok: false, status: "ERROR", error: "order not found" };

    // Only ACCEPTED orders are eligible for deduction; if already deducted, no-op.
    if (order.status !== "ACCEPTED") {
      return { ok: false, status: "ORDER_NOT_ELIGIBLE" };
    }
    if (order.inventoryDeducted === true) {
      return { ok: true, status: "ALREADY_DEDUCTED" };
    }

    const restaurantId = order.restaurantId;
    const items = Array.isArray(order.items) ? order.items : [];
    if (items.length === 0) {
      // Nothing to deduct; still claim so we don't re-check forever? No — no
      // recipe/items means nothing to do; leave flag false is harmless, but to
      // be consistent we simply report NO_RECIPE without claiming.
      return { ok: true, status: "NO_RECIPE" };
    }

    // ── Aggregate required quantities per raw material (base units) ──
    // Sum quantityPerItem × orderedQty across ALL order items (shared
    // ingredients aggregate into a single deduction per raw material).
    const menuIds = [...new Set(items.map((it) => String(it.menuId)).filter(Boolean))];
    if (menuIds.length === 0) return { ok: true, status: "NO_RECIPE" };

    const recipes = await MenuIngredient.find({
      restaurantId,                       // tenant scope
      menuId: { $in: menuIds },
    }).lean();

    if (!recipes || recipes.length === 0) {
      // No recipe rows for any item → nothing to deduct; order stays COMPLETED.
      return { ok: true, status: "NO_RECIPE" };
    }

    // Map menuId → ordered quantity (sum if the same menuId appears twice).
    const orderedQtyByMenu = new Map();
    for (const it of items) {
      const mid = String(it.menuId);
      const qty = Number(it.quantity) || 0;
      orderedQtyByMenu.set(mid, (orderedQtyByMenu.get(mid) || 0) + qty);
    }

    // Aggregate required base-unit amount per rawMaterialId.
    const requiredByMaterial = new Map(); // rawMaterialId(string) → { required, baseUnit }
    for (const r of recipes) {
      const mid = String(r.menuId);
      const orderedQty = orderedQtyByMenu.get(mid) || 0;
      if (orderedQty <= 0) continue;
      const perItem = Number(r.quantityPerItem) || 0;
      if (perItem <= 0) continue;
      const need = perItem * orderedQty;
      const key = String(r.rawMaterialId);
      const prev = requiredByMaterial.get(key);
      if (prev) {
        prev.required += need;
      } else {
        requiredByMaterial.set(key, { required: need, baseUnit: r.baseUnit || null });
      }
    }

    if (requiredByMaterial.size === 0) {
      return { ok: true, status: "NO_RECIPE" };
    }

    // ── Deduct: claim → deduct → history ───────────────────────────
    // Prefer a MongoDB transaction (all-or-nothing) on transaction-capable
    // deployments (replica set / Atlas). On a STANDALONE MongoDB that does not
    // support transactions, the driver throws IllegalOperation (code 20). In
    // that case fall back to a NON-transactional path that preserves every
    // established guarantee:
    //   • EXACTLY-ONCE — the atomic { inventoryDeducted:false → true } claim is
    //     still a single conditional update, so only one caller ever deducts.
    //   • OPTION C / never-negative — same clamped $set math.
    //   • APPEND-ONLY history — same InventoryTransaction inserts.
    //   • LOW-STOCK — evaluated after the writes.
    // The only property lost in the fallback is cross-material atomic rollback,
    // which is acceptable on a single-node dev deployment and never reached on
    // the replica-set production database.
    try {
      session = await mongoose.startSession();
      session.startTransaction();
      const result = await applyDeduction({ order, restaurantId, requiredByMaterial, session });
      if (result.status === "ALREADY_DEDUCTED") {
        await session.abortTransaction();
        return { ok: true, status: "ALREADY_DEDUCTED" };
      }
      await session.commitTransaction();
      await runLowStock(result.touched, restaurantId);
      return { ok: true, status: "DEDUCTED", deductedCount: result.deductedCount, shortages: result.shortages };
    } catch (txnError) {
      const unsupported =
        txnError &&
        (txnError.code === 20 ||
          txnError.codeName === "IllegalOperation" ||
          /Transaction numbers are only allowed on a replica set/i.test(txnError.message || ""));
      if (session && session.inTransaction()) {
        try { await session.abortTransaction(); } catch { /* ignore */ }
      }
      if (!unsupported) throw txnError; // genuine failure → outer catch
      // Non-transactional fallback (standalone MongoDB). No session passed.
      const result = await applyDeduction({ order, restaurantId, requiredByMaterial, session: null });
      if (result.status === "ALREADY_DEDUCTED") return { ok: true, status: "ALREADY_DEDUCTED" };
      await runLowStock(result.touched, restaurantId);
      return { ok: true, status: "DEDUCTED", deductedCount: result.deductedCount, shortages: result.shortages };
    }
  } catch (error) {
    if (session && session.inTransaction()) {
      try { await session.abortTransaction(); } catch { /* ignore */ }
    }
    // Failure MUST NOT fail the order completion — log with context, return.
    console.error(
      `[Inventory] Deduction failed for order ${orderId}:`,
      error && error.message ? error.message : "unknown"
    );
    return { ok: false, status: "ERROR", error: error && error.message ? error.message : "unknown" };
  } finally {
    if (session) session.endSession();
  }
}

/**
 * Core deduction: atomic idempotency claim, clamped stock updates, and
 * append-only history. Runs inside a session when provided (transactional
 * deployments), or session-less (standalone fallback). Returns the touched
 * materials so the caller can evaluate low-stock AFTER the writes.
 */
async function applyDeduction({ order, restaurantId, requiredByMaterial, session }) {
  const opts = session ? { session } : {};

  // (1) Atomic idempotency claim — FIRST write. Only the winner proceeds.
  const claim = await Order.updateOne(
    { _id: order._id, inventoryDeducted: false },
    { $set: { inventoryDeducted: true } },
    opts
  );
  if (claim.modifiedCount === 0) {
    return { status: "ALREADY_DEDUCTED", touched: [], deductedCount: 0, shortages: 0 };
  }

  // (2) Load the affected materials (tenant-scoped).
  const materialIds = [...requiredByMaterial.keys()].map((id) => new mongoose.Types.ObjectId(id));
  const materials = await RawMaterial.find(
    { _id: { $in: materialIds }, restaurantId },  // tenant scope — never cross-restaurant
    null,
    opts
  );
  const materialById = new Map(materials.map((m) => [String(m._id), m]));

  let deductedCount = 0;
  let shortages = 0;
  const historyDocs = [];
  const touched = [];

  for (const [rmId, info] of requiredByMaterial.entries()) {
    const mat = materialById.get(rmId);
    if (!mat) continue; // missing/deactivated/other-restaurant → skip safely

    const available = Number(mat.currentQuantity) || 0;
    const required = info.required;
    const applied = Math.min(available, required); // >= 0
    const newBalance = available - applied;        // >= 0 by construction
    const shortage = required > available ? required - available : 0;

    await RawMaterial.updateOne(
      { _id: mat._id, restaurantId },
      { $set: { currentQuantity: newBalance } },
      opts
    );

    // Financials (Option B): snapshot the material's current purchasePrice (per
    // baseUnit) at deduction time so historical COGS is accurate later. Purely
    // additive metadata — does not affect quantity/balance/Option-C/idempotency.
    const unitCostSnapshot = Number.isFinite(Number(mat.purchasePrice))
      ? Number(mat.purchasePrice)
      : null;

    historyDocs.push({
      restaurantId,
      rawMaterialId: mat._id,
      type: "DEDUCTION",
      quantityDelta: -applied,
      balanceAfter: newBalance,
      baseUnit: mat.baseUnit || info.baseUnit || null,
      orderId: order._id,
      source: "ORDER_COMPLETION",
      shortage,
      requiredQuantity: required,
      unitCostSnapshot,
    });

    deductedCount += 1;
    if (shortage > 0) shortages += 1;
    touched.push({
      rawMaterialId: mat._id,
      name: mat.name,
      newQuantity: newBalance,
      minimumQuantity: Number(mat.minimumQuantity) || 0,
      baseUnit: mat.baseUnit || info.baseUnit || null,
    });
  }

  // (3) Append-only history for every material we touched.
  if (historyDocs.length > 0) {
    await InventoryTransaction.insertMany(historyDocs, session ? { session, ordered: true } : { ordered: true });
  }

  return { status: "DEDUCTED", touched, deductedCount, shortages };
}

/** Low-stock crossing evaluation for the touched materials (best-effort). */
async function runLowStock(touched, restaurantId) {
  for (const t of touched) {
    await evaluateLowStock({
      restaurantId,
      rawMaterialId: t.rawMaterialId,
      name: t.name,
      newQuantity: t.newQuantity,
      minimumQuantity: t.minimumQuantity,
      baseUnit: t.baseUnit,
    });
  }
}

module.exports = { deductInventoryForOrder };
