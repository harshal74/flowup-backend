const RawMaterial = require("../models/RawMaterial");
const InventoryTransaction = require("../models/InventoryTransaction");
const mongoose = require("mongoose");
const { evaluateLowStock } = require("../services/lowStockAlert.service");

const { UNITS, BASE_UNITS } = RawMaterial;

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// Escape user input before using inside a MongoDB $regex (matches category.controller).
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// ── POST /api/inventory ─────────────────────────────────────────
// Create a raw material (tenant-scoped). Admin-only via `protect`.
const createRawMaterial = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { name, unit, baseUnit, currentQuantity, minimumQuantity, purchasePrice, supplier } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Raw material name is required" });
    }
    if (!unit || !UNITS.includes(unit)) {
      return res.status(400).json({ success: false, message: `unit must be one of: ${UNITS.join(", ")}` });
    }
    if (!baseUnit || !BASE_UNITS.includes(baseUnit)) {
      return res.status(400).json({ success: false, message: `baseUnit must be one of: ${BASE_UNITS.join(", ")}` });
    }

    // Numeric validation — reject negatives / non-numbers with a clean 400.
    const current = currentQuantity === undefined ? 0 : Number(currentQuantity);
    const minimum = minimumQuantity === undefined ? 0 : Number(minimumQuantity);
    const price   = purchasePrice   === undefined ? 0 : Number(purchasePrice);
    if (!isFiniteNumber(current) || current < 0) {
      return res.status(400).json({ success: false, message: "currentQuantity must be a number >= 0" });
    }
    if (!isFiniteNumber(minimum) || minimum < 0) {
      return res.status(400).json({ success: false, message: "minimumQuantity must be a number >= 0" });
    }
    if (!isFiniteNumber(price) || price < 0) {
      return res.status(400).json({ success: false, message: "purchasePrice must be a number >= 0" });
    }

    // Case-insensitive duplicate name check within the restaurant (matches Category).
    const safeName = escapeRegex(name.trim());
    const existing = await RawMaterial.findOne({
      restaurantId,
      name: { $regex: `^${safeName}$`, $options: "i" },
    });
    if (existing) {
      return res.status(409).json({ success: false, message: "Raw material already exists" });
    }

    const material = await RawMaterial.create({
      restaurantId,
      name: name.trim(),
      unit,
      baseUnit,
      currentQuantity: current,
      minimumQuantity: minimum,
      purchasePrice: price,
      supplier: supplier ? String(supplier).trim() : "",
    });

    return res.status(201).json({ success: true, message: "Raw material created successfully", data: material });
  } catch (error) {
    console.error("Create RawMaterial Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── GET /api/inventory ──────────────────────────────────────────
// List raw materials for the restaurant. Optional ?search= and ?active=true/false.
const getRawMaterials = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { search, active } = req.query;

    const filter = { restaurantId };
    if (active === "true")  filter.isActive = true;
    if (active === "false") filter.isActive = false;
    if (search && String(search).trim()) {
      filter.name = { $regex: escapeRegex(String(search).trim()), $options: "i" };
    }

    const materials = await RawMaterial.find(filter).sort({ name: 1, createdAt: -1 });

    return res.status(200).json({ success: true, count: materials.length, data: materials });
  } catch (error) {
    console.error("Get RawMaterials Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── GET /api/inventory/summary ──────────────────────────────────
// Read-only, tenant-scoped operational summary (Step 9): totals, low-stock
// count + list, and total inventory value (Σ currentQuantity × purchasePrice
// over ACTIVE materials). Aggregation over existing RawMaterial data only — no
// new model, no analytics/valuation engine. restaurantId from req.user only.
const getInventorySummary = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;

    const materials = await RawMaterial.find({ restaurantId })
      .select("name unit baseUnit currentQuantity minimumQuantity purchasePrice isActive")
      .lean();

    let activeCount = 0;
    let inactiveCount = 0;
    let inventoryValue = 0;
    const lowStock = [];

    for (const m of materials) {
      const active = m.isActive !== false;
      if (active) activeCount += 1; else inactiveCount += 1;

      // Value is only meaningful for active stock; guard against non-finite.
      if (active) {
        const qty = Number(m.currentQuantity) || 0;
        const price = Number(m.purchasePrice) || 0;
        inventoryValue += qty * price;
      }

      // Low-stock only counts if the owner actually set a minimum (> 0).
      // minimumQuantity = 0 means "no threshold set" — never count as low.
      if (active && Number(m.minimumQuantity) > 0 && (Number(m.currentQuantity) || 0) <= (Number(m.minimumQuantity) || 0)) {
        lowStock.push({
          _id: m._id,
          name: m.name,
          currentQuantity: m.currentQuantity,
          minimumQuantity: m.minimumQuantity,
          baseUnit: m.baseUnit,
        });
      }
    }

    // Round value to 2 dp to avoid floating-point noise in the UI.
    inventoryValue = Math.round(inventoryValue * 100) / 100;

    return res.status(200).json({
      success: true,
      data: {
        totalMaterials: materials.length,
        activeMaterials: activeCount,
        inactiveMaterials: inactiveCount,
        lowStockCount: lowStock.length,
        inventoryValue,
        lowStock,
      },
    });
  } catch (error) {
    console.error("Inventory Summary Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── GET /api/inventory/:id ──────────────────────────────────────
const getRawMaterialById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    const restaurantId = req.user.restaurantId;
    const material = await RawMaterial.findOne({ _id: id, restaurantId });

    if (!material) {
      return res.status(404).json({ success: false, message: "Raw material not found" });
    }

    return res.status(200).json({ success: true, data: material });
  } catch (error) {
    console.error("Get RawMaterial Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── PATCH /api/inventory/:id ────────────────────────────────────
// Update whitelisted fields (tenant-scoped). Does NOT set currentQuantity here —
// stock changes go through the dedicated /adjust endpoint to keep intent explicit.
const updateRawMaterial = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    const restaurantId = req.user.restaurantId;
    const material = await RawMaterial.findOne({ _id: id, restaurantId });
    if (!material) {
      return res.status(404).json({ success: false, message: "Raw material not found" });
    }

    const { name, unit, baseUnit, minimumQuantity, purchasePrice, supplier, isActive } = req.body;
    const allowedUpdate = {};

    if (name !== undefined) {
      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, message: "Raw material name cannot be empty" });
      }
      const safeName = escapeRegex(name.trim());
      const dup = await RawMaterial.findOne({
        _id: { $ne: id },
        restaurantId,
        name: { $regex: `^${safeName}$`, $options: "i" },
      });
      if (dup) {
        return res.status(409).json({ success: false, message: "Another raw material with this name already exists" });
      }
      allowedUpdate.name = name.trim();
    }
    if (unit !== undefined) {
      if (!UNITS.includes(unit)) {
        return res.status(400).json({ success: false, message: `unit must be one of: ${UNITS.join(", ")}` });
      }
      allowedUpdate.unit = unit;
    }
    if (baseUnit !== undefined) {
      if (!BASE_UNITS.includes(baseUnit)) {
        return res.status(400).json({ success: false, message: `baseUnit must be one of: ${BASE_UNITS.join(", ")}` });
      }
      // Guard: changing the baseUnit after transactions have been recorded would
      // silently corrupt all historical balances and COGS calculations (they were
      // stored in the OLD unit). Block the change if any history exists.
      if (baseUnit !== material.baseUnit) {
        const txnCount = await InventoryTransaction.countDocuments({ rawMaterialId: material._id });
        if (txnCount > 0) {
          return res.status(409).json({
            success: false,
            message: `Cannot change base unit after stock history has been recorded (${txnCount} transaction${txnCount === 1 ? '' : 's'} exist). Reset stock to 0 first or create a new material.`,
          });
        }
      }
      allowedUpdate.baseUnit = baseUnit;
    }
    if (minimumQuantity !== undefined) {
      const m = Number(minimumQuantity);
      if (!isFiniteNumber(m) || m < 0) {
        return res.status(400).json({ success: false, message: "minimumQuantity must be a number >= 0" });
      }
      allowedUpdate.minimumQuantity = m;
    }
    if (purchasePrice !== undefined) {
      const p = Number(purchasePrice);
      if (!isFiniteNumber(p) || p < 0) {
        return res.status(400).json({ success: false, message: "purchasePrice must be a number >= 0" });
      }
      allowedUpdate.purchasePrice = p;
    }
    if (supplier !== undefined) allowedUpdate.supplier = String(supplier).trim();
    if (isActive !== undefined) allowedUpdate.isActive = !!isActive;

    const updated = await RawMaterial.findOneAndUpdate(
      { _id: id, restaurantId },
      allowedUpdate,
      { returnDocument: "after", runValidators: true }
    );

    // Step 4: if minimumQuantity changed, re-evaluate the low-stock crossing.
    // Raising the minimum can push a currently-fine material below threshold
    // (→ fresh alert on the false→true flip); lowering it can recover a
    // material above threshold (→ clears the flag, re-arms). The centralized
    // crossing/dedup logic ensures no repeat alert if it was already alerting.
    if (updated && allowedUpdate.minimumQuantity !== undefined) {
      await evaluateLowStock({
        restaurantId,
        rawMaterialId: updated._id,
        name: updated.name,
        newQuantity: Number(updated.currentQuantity) || 0,
        minimumQuantity: Number(updated.minimumQuantity) || 0,
        baseUnit: updated.baseUnit,
      });
    }

    return res.status(200).json({ success: true, message: "Raw material updated successfully", data: updated });
  } catch (error) {
    console.error("Update RawMaterial Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── PATCH /api/inventory/:id/adjust ─────────────────────────────
// Explicit manual stock adjustment (tenant-scoped). Body: { delta } (may be
// negative) OR { set } (absolute value). Never lets currentQuantity go negative.
const adjustRawMaterialStock = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    const restaurantId = req.user.restaurantId;
    const { delta, set } = req.body;

    if (delta === undefined && set === undefined) {
      return res.status(400).json({ success: false, message: "Provide `delta` (change) or `set` (absolute quantity)." });
    }

    const material = await RawMaterial.findOne({ _id: id, restaurantId });
    if (!material) {
      return res.status(404).json({ success: false, message: "Raw material not found" });
    }

    let nextQuantity;
    if (set !== undefined) {
      const s = Number(set);
      if (!isFiniteNumber(s) || s < 0) {
        return res.status(400).json({ success: false, message: "`set` must be a number >= 0" });
      }
      nextQuantity = s;
    } else {
      const d = Number(delta);
      if (!isFiniteNumber(d)) {
        return res.status(400).json({ success: false, message: "`delta` must be a number" });
      }
      nextQuantity = material.currentQuantity + d;
      if (nextQuantity < 0) {
        return res.status(400).json({ success: false, message: "Adjustment would make stock negative" });
      }
    }

    const previousQuantity = material.currentQuantity;
    material.currentQuantity = nextQuantity;
    await material.save();

    // Step 7: append-only ADJUSTMENT history for the manual change (best-effort;
    // never alters adjust semantics or blocks the response). No orderId — a
    // manual adjustment is not caused by an order. quantityDelta is signed.
    try {
      await InventoryTransaction.create({
        restaurantId,
        rawMaterialId: material._id,
        type: "ADJUSTMENT",
        quantityDelta: nextQuantity - previousQuantity,
        balanceAfter: nextQuantity,
        baseUnit: material.baseUnit || null,
        orderId: null,
        source: "MANUAL_ADJUSTMENT",
        shortage: 0,
        requiredQuantity: null,
      });
    } catch (histErr) {
      console.error("[Inventory] adjustment history failed:", histErr && histErr.message);
    }

    // Step 4: low-stock crossing evaluation after a manual adjustment.
    // Reuses the centralized crossing/dedup logic (best-effort; never blocks).
    await evaluateLowStock({
      restaurantId,
      rawMaterialId: material._id,
      name: material.name,
      newQuantity: material.currentQuantity,
      minimumQuantity: Number(material.minimumQuantity) || 0,
      baseUnit: material.baseUnit,
    });

    return res.status(200).json({ success: true, message: "Stock adjusted successfully", data: material });
  } catch (error) {
    console.error("Adjust RawMaterial Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── PATCH /api/inventory/:id/toggle-status ──────────────────────
const toggleRawMaterialStatus = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    const restaurantId = req.user.restaurantId;
    const material = await RawMaterial.findOne({ _id: id, restaurantId });

    if (!material) {
      return res.status(404).json({ success: false, message: "Raw material not found" });
    }

    material.isActive = !material.isActive;
    await material.save();

    return res.status(200).json({
      success: true,
      message: `Raw material ${material.isActive ? "activated" : "deactivated"} successfully`,
      data: material,
    });
  } catch (error) {
    console.error("Toggle RawMaterial Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── PATCH /api/inventory/:id/purchase ───────────────────────────
// Stock-in / purchase (Step 8). Increases currentQuantity by a POSITIVE
// quantity (in baseUnit) and records exactly one PURCHASE InventoryTransaction.
// Tenant-scoped; mutation auth enforced at the route (adminOrStaff +
// requireInventoryManager). Optional `unitPrice` updates the material's
// purchasePrice (metadata only — no accounting/valuation system introduced).
const purchaseRawMaterialStock = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    const restaurantId = req.user.restaurantId;
    const { quantity, unitPrice } = req.body;

    const qty = Number(quantity);
    if (!isFiniteNumber(qty) || qty <= 0) {
      return res.status(400).json({ success: false, message: "quantity must be a number greater than 0" });
    }

    const material = await RawMaterial.findOne({ _id: id, restaurantId });
    if (!material) {
      return res.status(404).json({ success: false, message: "Raw material not found" });
    }

    // Optional purchase price update (metadata only). Must be > 0 so COGS stays accurate.
    if (unitPrice !== undefined) {
      const p = Number(unitPrice);
      if (!isFiniteNumber(p) || p <= 0) {
        return res.status(400).json({ success: false, message: "unitPrice must be a number greater than 0" });
      }
      material.purchasePrice = p;
    }

    const newBalance = material.currentQuantity + qty;
    material.currentQuantity = newBalance;
    await material.save();

    // Append-only PURCHASE history (best-effort; never alters purchase semantics).
    try {
      await InventoryTransaction.create({
        restaurantId,
        rawMaterialId: material._id,
        type: "PURCHASE",
        quantityDelta: qty,             // positive
        balanceAfter: newBalance,
        baseUnit: material.baseUnit || null,
        orderId: null,
        source: "PURCHASE",
        shortage: 0,
        requiredQuantity: null,
      });
    } catch (histErr) {
      console.error("[Inventory] purchase history failed:", histErr && histErr.message);
    }

    // Step 4: a purchase can lift stock above the threshold → clear/re-arm the
    // low-stock alert flag. Reuses the centralized crossing logic (best-effort).
    await evaluateLowStock({
      restaurantId,
      rawMaterialId: material._id,
      name: material.name,
      newQuantity: material.currentQuantity,
      minimumQuantity: Number(material.minimumQuantity) || 0,
      baseUnit: material.baseUnit,
    });

    return res.status(200).json({ success: true, message: "Stock added successfully", data: material });
  } catch (error) {
    console.error("Purchase RawMaterial Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── GET /api/inventory/:id/history ──────────────────────────────
// Append-only InventoryTransaction history for one material (Step 7).
// Tenant-scoped: the material must belong to req.user.restaurantId (else 404),
// and transactions are queried by { rawMaterialId, restaurantId }. Read-only;
// paginated with a default + max limit. Never creates/updates history.
const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 200;

const getRawMaterialHistory = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    const restaurantId = req.user.restaurantId;

    // Verify the material belongs to this restaurant — prevents reading another
    // restaurant's history by guessing a material id (returns 404).
    const material = await RawMaterial.findOne({ _id: id, restaurantId }).select("_id name baseUnit").lean();
    if (!material) {
      return res.status(404).json({ success: false, message: "Raw material not found" });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || HISTORY_DEFAULT_LIMIT, 1), HISTORY_MAX_LIMIT);
    const page  = Math.max(Number(req.query.page) || 1, 1);
    const skip  = (page - 1) * limit;

    const filter = { restaurantId, rawMaterialId: id }; // material + tenant scope
    const total = await InventoryTransaction.countDocuments(filter);
    const history = await InventoryTransaction.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    return res.status(200).json({
      success: true,
      count: history.length,
      total,
      page,
      limit,
      material: { _id: material._id, name: material.name, baseUnit: material.baseUnit },
      data: history,
    });
  } catch (error) {
    console.error("Get RawMaterial History Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── DELETE /api/inventory/:id ───────────────────────────────────
// Hard delete (tenant-scoped). Also removes all MenuIngredient recipe mappings
// that reference this material, so future deductions do not silently miss it.
// Prefer toggle-status (soft) in the UI; delete is available for cleanup.
const deleteRawMaterial = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    const restaurantId = req.user.restaurantId;

    // Verify ownership before deleting anything.
    const existing = await RawMaterial.findOne({ _id: id, restaurantId }).select("_id").lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: "Raw material not found" });
    }

    // Remove all recipe mappings that reference this material (same tenant only).
    // This prevents orphaned MenuIngredient rows that would cause silent
    // deduction misses for any menu item still mapped to the deleted material.
    const MenuIngredient = require("../models/MenuIngredient");
    await MenuIngredient.deleteMany({ restaurantId, rawMaterialId: id });

    // Now hard-delete the material itself.
    await RawMaterial.findOneAndDelete({ _id: id, restaurantId });

    return res.status(200).json({ success: true, message: "Raw material and its recipe mappings deleted successfully" });
  } catch (error) {
    console.error("Delete RawMaterial Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = {
  createRawMaterial,
  getRawMaterials,
  getInventorySummary,
  getRawMaterialById,
  updateRawMaterial,
  adjustRawMaterialStock,
  purchaseRawMaterialStock,
  toggleRawMaterialStatus,
  getRawMaterialHistory,
  deleteRawMaterial,
};
