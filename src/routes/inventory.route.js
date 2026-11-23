const express = require("express");
const {
  createRawMaterial,
  getRawMaterials,
  getRawMaterialById,
  updateRawMaterial,
  adjustRawMaterialStock,
  purchaseRawMaterialStock,
  toggleRawMaterialStatus,
  getRawMaterialHistory,
  getInventorySummary,
  deleteRawMaterial,
} = require("../controllers/inventory.controller");
const protect = require("../middleware/auth.middleware");
const { adminOrStaff, requireInventoryManager } = require("../middleware/inventoryAuth");
const {
  getMenuIngredients,
  setMenuIngredients,
  removeMenuIngredient,
} = require("../controllers/recipe.controller");

const router = express.Router();

/**
 * Inventory — Raw Material Management (Step 1) + Recipe/Ingredient mapping (Step 2)
 * + Step 5 authorization (Admin account OR Staff ADMIN/ASSISTANT).
 *
 * Auth (Step 5, Option A):
 *   • Raw-material READS  → adminOrStaff (Admin account or any authenticated staff
 *     of the restaurant can view). Tenant from req.user.restaurantId.
 *   • Raw-material MUTATIONS → adminOrStaff + requireInventoryManager
 *     (Admin account OR staff ADMIN/ASSISTANT; CHEF/WAITER denied 403).
 *   • Recipe endpoints (Step 2) remain admin-account only (`protect`) — unchanged.
 * Tenant identity is ALWAYS req.user.restaurantId; never from the body.
 */

// ── Recipe / ingredient mapping (Step 2) — admin-account only (unchanged) ──
// Registered BEFORE the "/:id" raw-material routes so "menu" is never treated
// as a raw-material id.
router.get("/menu/:menuId/ingredients",                    protect, getMenuIngredients);
router.put("/menu/:menuId/ingredients",                    protect, setMenuIngredients);
router.delete("/menu/:menuId/ingredients/:rawMaterialId",  protect, removeMenuIngredient);

// ── Collection routes ────────────────────────────────────────────
router.post("/", adminOrStaff, requireInventoryManager, createRawMaterial);
router.get("/",  adminOrStaff, getRawMaterials);

// Operational summary (Step 9) — static path BEFORE "/:id" so "summary" is not
// matched as a raw-material id. Read-only, tenant-scoped.
router.get("/summary", adminOrStaff, getInventorySummary);

// ── Parameterised routes ─────────────────────────────────────────
// History (Step 7) — read-only, adminOrStaff (any authenticated staff of the
// restaurant + admin account). Tenant-scoped in the controller. Placed before
// the generic "/:id" GET for clarity (Express matches the more specific path).
router.get("/:id/history",         adminOrStaff, getRawMaterialHistory);
router.get("/:id",                 adminOrStaff, getRawMaterialById);
router.patch("/:id",               adminOrStaff, requireInventoryManager, updateRawMaterial);
router.patch("/:id/adjust",        adminOrStaff, requireInventoryManager, adjustRawMaterialStock);
router.patch("/:id/purchase",      adminOrStaff, requireInventoryManager, purchaseRawMaterialStock);
router.patch("/:id/toggle-status", adminOrStaff, requireInventoryManager, toggleRawMaterialStatus);
router.delete("/:id",              adminOrStaff, requireInventoryManager, deleteRawMaterial);

module.exports = router;
