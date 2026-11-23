const MenuIngredient = require("../models/MenuIngredient");
const Menu           = require("../models/Menu");
const RawMaterial    = require("../models/RawMaterial");
const mongoose       = require("mongoose");

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function isPositiveNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

// Shape a mapping for the client (with populated raw-material display fields).
function shapeIngredient(doc) {
  const rm = doc.rawMaterialId && typeof doc.rawMaterialId === "object" ? doc.rawMaterialId : null;
  return {
    _id: doc._id,
    menuId: rm ? doc.menuId : doc.menuId,
    rawMaterialId: rm ? rm._id : doc.rawMaterialId,
    rawMaterialName: rm ? rm.name : undefined,
    unit: rm ? rm.unit : undefined,          // display unit (kg/g/…)
    baseUnit: doc.baseUnit,                   // storage unit the quantity is in
    quantityPerItem: doc.quantityPerItem,
    isActive: rm ? rm.isActive : undefined,
  };
}

// ── GET /api/inventory/menu/:menuId/ingredients ─────────────────
// Return the recipe (ingredient mappings) for one menu item. Tenant-scoped.
// An empty recipe is valid (returns []).
const getMenuIngredients = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { menuId } = req.params;
    if (!isValidId(menuId)) return res.status(400).json({ success: false, message: "Invalid menu ID" });

    // Verify the menu item belongs to this restaurant.
    const menu = await Menu.findOne({ _id: menuId, restaurantId }).select("_id").lean();
    if (!menu) return res.status(404).json({ success: false, message: "Menu item not found" });

    const ingredients = await MenuIngredient.find({ restaurantId, menuId })
      .populate("rawMaterialId", "name unit isActive")
      .sort({ createdAt: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: ingredients.length,
      data: ingredients.map(shapeIngredient),
    });
  } catch (error) {
    console.error("Get Menu Ingredients Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── PUT /api/inventory/menu/:menuId/ingredients ─────────────────
// Replace the FULL recipe for a menu item with the supplied list.
// Body: { ingredients: [ { rawMaterialId, quantityPerItem }, ... ] }
// Safe replace: validates everything first, then deletes existing + inserts new
// inside a transaction so a partial/duplicate state can never persist.
const setMenuIngredients = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const restaurantId = req.user.restaurantId;
    const { menuId } = req.params;
    if (!isValidId(menuId)) return res.status(400).json({ success: false, message: "Invalid menu ID" });

    const list = Array.isArray(req.body?.ingredients) ? req.body.ingredients : null;
    if (!list) {
      return res.status(400).json({ success: false, message: "`ingredients` must be an array" });
    }

    // 1) Verify menu item belongs to this restaurant.
    const menu = await Menu.findOne({ _id: menuId, restaurantId }).select("_id").lean();
    if (!menu) return res.status(404).json({ success: false, message: "Menu item not found" });

    // 2) Validate each entry BEFORE any write. Reject duplicates, bad ids,
    //    non-positive quantities, and cross-restaurant raw materials.
    const seen = new Set();
    const prepared = [];
    for (const entry of list) {
      const rawMaterialId = entry?.rawMaterialId;
      const quantityPerItem = Number(entry?.quantityPerItem);

      if (!rawMaterialId || !isValidId(rawMaterialId)) {
        // transaction not yet started — do NOT call abortTransaction
        return res.status(400).json({ success: false, message: "Each ingredient needs a valid rawMaterialId" });
      }
      if (!isPositiveNumber(quantityPerItem)) {
        return res.status(400).json({ success: false, message: "quantityPerItem must be a number greater than 0" });
      }
      const key = String(rawMaterialId);
      if (seen.has(key)) {
        return res.status(409).json({ success: false, message: "Duplicate raw material in ingredient list" });
      }
      seen.add(key);

      // Cross-restaurant guard: the raw material MUST belong to this restaurant.
      const rm = await RawMaterial.findOne({ _id: rawMaterialId, restaurantId }).select("baseUnit").lean();
      if (!rm) {
        return res.status(400).json({
          success: false,
          message: "One or more raw materials do not exist for this restaurant",
        });
      }

      prepared.push({
        restaurantId,
        menuId,
        rawMaterialId,
        quantityPerItem,
        baseUnit: rm.baseUnit,
      });
    }

    // 3) Safe replace: clear then insert.
    // Prefer a transaction (atomic delete+insert) on transaction-capable
    // deployments (replica set / Atlas). If the connected MongoDB is a
    // standalone that does NOT support transactions, the driver throws
    // IllegalOperation (code 20, "Transaction numbers are only allowed on a
    // replica set member or mongos"). In that case fall back to a
    // non-transactional delete-then-insert so recipe saves still persist in
    // such environments. Integrity is still protected by the unique compound
    // index { restaurantId, menuId, rawMaterialId } (duplicates rejected), and
    // the pre-validation above guarantees the prepared set is already clean.
    try {
      session.startTransaction();
      await MenuIngredient.deleteMany({ restaurantId, menuId }, { session });
      if (prepared.length > 0) {
        await MenuIngredient.insertMany(prepared, { session, ordered: true });
      }
      await session.commitTransaction();
    } catch (txnError) {
      const unsupported =
        txnError &&
        (txnError.code === 20 ||
          txnError.codeName === "IllegalOperation" ||
          /Transaction numbers are only allowed on a replica set/i.test(txnError.message || ""));
      if (session.inTransaction()) {
        try { await session.abortTransaction(); } catch { /* ignore */ }
      }
      if (!unsupported) throw txnError; // genuine failure — surface to outer catch
      // Non-transactional fallback (standalone MongoDB).
      await MenuIngredient.deleteMany({ restaurantId, menuId });
      if (prepared.length > 0) {
        await MenuIngredient.insertMany(prepared, { ordered: true });
      }
    }

    // 4) Return the persisted recipe (populated).
    const ingredients = await MenuIngredient.find({ restaurantId, menuId })
      .populate("rawMaterialId", "name unit isActive")
      .sort({ createdAt: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: "Recipe updated successfully",
      count: ingredients.length,
      data: ingredients.map(shapeIngredient),
    });
  } catch (error) {
    if (session.inTransaction()) {
      try { await session.abortTransaction(); } catch { /* ignore */ }
    }
    // Unique-index violation (concurrent duplicate) → clean 409.
    if (error && error.code === 11000) {
      return res.status(409).json({ success: false, message: "Duplicate raw material in ingredient list" });
    }
    console.error("Set Menu Ingredients Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  } finally {
    session.endSession();
  }
};

// ── DELETE /api/inventory/menu/:menuId/ingredients/:rawMaterialId ─
// Remove a single ingredient mapping. Tenant-scoped.
const removeMenuIngredient = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { menuId, rawMaterialId } = req.params;
    if (!isValidId(menuId) || !isValidId(rawMaterialId)) {
      return res.status(400).json({ success: false, message: "Invalid ID" });
    }

    const deleted = await MenuIngredient.findOneAndDelete({ restaurantId, menuId, rawMaterialId });
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Ingredient mapping not found" });
    }

    return res.status(200).json({ success: true, message: "Ingredient removed successfully" });
  } catch (error) {
    console.error("Remove Menu Ingredient Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = {
  getMenuIngredients,
  setMenuIngredients,
  removeMenuIngredient,
};
