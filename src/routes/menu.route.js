const express = require("express");

const {
  createMenu,
  getAdminMenus,
  getPublicMenus,
  getMenuById,
  getMenusByCategory,
  updateMenu,
  deleteMenu,
  toggleAvailability,
  toggleRecommendation,
} = require("../controllers/menu.controller");

const protect = require("../middleware/auth.middleware");

const router = express.Router();

router.post("/", protect, createMenu);

router.get("/", getPublicMenus);

router.get("/admin", protect, getAdminMenus);

router.get("/:id", getMenuById);

router.get(
  "/category/:categoryId",
  getMenusByCategory
);

router.put("/:id", protect, updateMenu);

router.delete("/:id", protect, deleteMenu);

router.patch(
  "/:id/availability",
  protect,
  toggleAvailability
);

router.patch(
  "/:id/recommendation",
  protect,
  toggleRecommendation
);

module.exports = router;