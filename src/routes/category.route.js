const express = require("express");

const {
  createCategory,
  getCategories,
  getCategoryById,
  updateCategory,
  deleteCategory,
  toggleCategoryStatus,
} = require("../controllers/category.controller");

const protect = require("../middleware/auth.middleware");

const router = express.Router();

router.post("/", protect, createCategory);

router.get("/", getCategories);

router.get("/:id", getCategoryById);

router.put("/:id", protect, updateCategory);

router.delete("/:id", protect, deleteCategory);

router.patch(
  "/:id/toggle-status",
  protect,
  toggleCategoryStatus
);

module.exports = router;