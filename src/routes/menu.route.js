const express = require("express");
const resolvePublicRestaurant = require("../middleware/resolvePublicRestaurant");

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

router.get("/admin", protect, getAdminMenus);   // MUST be before /:id

router.get("/", resolvePublicRestaurant, getPublicMenus);

// /category/:categoryId MUST be before /:id so Express doesn't match "category" as an id
router.get(
  "/category/:categoryId",
  resolvePublicRestaurant,
  getMenusByCategory
);

router.get("/:id", resolvePublicRestaurant, getMenuById);

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