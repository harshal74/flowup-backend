const express = require("express");
const {
  createCategory,
  getCategories,
  getCategoryById,
  updateCategory,
  deleteCategory,
  toggleCategoryStatus,
  reorderCategories,
} = require("../controllers/category.controller");
const protect = require("../middleware/auth.middleware");

const router = express.Router();

// ── Static routes MUST come before /:id routes ──────────────────
router.post("/",          protect, createCategory);
router.get("/",                    getCategories);

// Bulk reorder — defined BEFORE /:id so Express doesn't treat
// "reorder" as an id param
router.patch("/reorder",  protect, reorderCategories);

// ── Parameterised routes ─────────────────────────────────────────
router.get("/:id",                 getCategoryById);
router.put("/:id",        protect, updateCategory);
router.delete("/:id",     protect, deleteCategory);
router.patch("/:id/toggle-status", protect, toggleCategoryStatus);

module.exports = router;
