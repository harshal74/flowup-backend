const Menu     = require("../models/Menu");
const mongoose = require("mongoose");

// Helper: validate ObjectId and return 400 if invalid
function badId(id, res) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ success: false, message: "Invalid ID format" });
    return true;
  }
  return false;
}

// Create Menu Item
const createMenu = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;

    const menu = await Menu.create({
      ...req.body,
      restaurantId,
    });

    return res.status(201).json({
      success: true,
      message: "Menu item created successfully",
      data: menu,
    });
  } catch (error) {
    console.error("Create Menu Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Get All Menu Items
const getAdminMenus = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;

    const menus = await Menu.find({
      restaurantId,
    })
      .populate("categoryId", "name")
      .sort({
        displayOrder: 1,
        createdAt: -1,
      });

    return res.status(200).json({
      success: true,
      count: menus.length,
      data: menus,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

const getPublicMenus = async (req, res) => {
  try {
    const restaurantId = req.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({ success: false, message: "restaurantId is required" });
    }

    const menus = await Menu.find({ restaurantId, isAvailable: true })
      .populate("categoryId", "name")
      .sort({ displayOrder: 1 });

    return res.status(200).json({ success: true, count: menus.length, data: menus });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Get Menu By Id — always scoped by restaurant (resolver or JWT)
const getMenuById = async (req, res) => {
  try {
    if (badId(req.params.id, res)) return;
    const restaurantId = req.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({ success: false, message: "restaurantId is required" });
    }

    const menu = await Menu.findOne({ _id: req.params.id, restaurantId }).populate("categoryId", "name");

    if (!menu) {
      return res.status(404).json({ success: false, message: "Menu item not found" });
    }

    return res.status(200).json({ success: true, data: menu });
  } catch (error) {
    console.error("Get Menu Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Get Menu By Category — scoped by restaurant (resolver or JWT)
const getMenusByCategory = async (req, res) => {
  try {
    const { categoryId } = req.params;
    const restaurantId = req.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({ success: false, message: "restaurantId is required" });
    }

    const menus = await Menu.find({ categoryId, restaurantId, isAvailable: true });

    return res.status(200).json({
      success: true,
      count: menus.length,
      data: menus,
    });
  } catch (error) {
    console.error("Category Menu Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Update Menu Item — scoped by restaurant, whitelisted fields
const updateMenu = async (req, res) => {
  try {
    if (badId(req.params.id, res)) return;
    const restaurantId = req.user.restaurantId;
    const menu = await Menu.findOne({ _id: req.params.id, restaurantId });
    if (!menu) {
      return res.status(404).json({ success: false, message: "Menu item not found" });
    }

    // Whitelist updatable fields — never allow restaurantId to be changed
    const {
      name, description, image, price, discountedPrice,
      isVeg, isAvailable, isRecommended, preparationTime,
      displayOrder, tags, categoryId,
    } = req.body;

    const allowed = {};
    if (name             !== undefined) allowed.name             = name;
    if (description      !== undefined) allowed.description      = description;
    if (image            !== undefined) allowed.image            = image;
    if (price            !== undefined) allowed.price            = price;
    if (discountedPrice  !== undefined) allowed.discountedPrice  = discountedPrice;
    if (isVeg            !== undefined) allowed.isVeg            = isVeg;
    if (isAvailable      !== undefined) allowed.isAvailable      = isAvailable;
    if (isRecommended    !== undefined) allowed.isRecommended    = isRecommended;
    if (preparationTime  !== undefined) allowed.preparationTime  = preparationTime;
    if (displayOrder     !== undefined) allowed.displayOrder     = displayOrder;
    if (tags             !== undefined) allowed.tags             = tags;
    if (categoryId       !== undefined) allowed.categoryId       = categoryId;

    const updatedMenu = await Menu.findOneAndUpdate(
      { _id: req.params.id, restaurantId },
      allowed,
      { returnDocument: 'after', runValidators: true }
    );

    return res.status(200).json({ success: true, message: "Menu updated successfully", data: updatedMenu });
  } catch (error) {
    console.error("Update Menu Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Delete Menu Item — scoped by restaurant
const deleteMenu = async (req, res) => {
  try {
    if (badId(req.params.id, res)) return;
    const restaurantId = req.user.restaurantId;
    const deleted = await Menu.findOneAndDelete({ _id: req.params.id, restaurantId });

    if (!deleted) {
      return res.status(404).json({ success: false, message: "Menu item not found" });
    }

    return res.status(200).json({ success: true, message: "Menu deleted successfully" });
  } catch (error) {
    console.error("Delete Menu Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Toggle Availability — scoped by restaurant
const toggleAvailability = async (req, res) => {
  try {
    if (badId(req.params.id, res)) return;
    const restaurantId = req.user.restaurantId;
    const menu = await Menu.findOne({ _id: req.params.id, restaurantId });

    if (!menu) {
      return res.status(404).json({ success: false, message: "Menu item not found" });
    }

    menu.isAvailable = !menu.isAvailable;
    await menu.save();

    return res.status(200).json({
      success: true,
      message: `Menu item ${menu.isAvailable ? "available" : "unavailable"} successfully`,
      data: menu,
    });
  } catch (error) {
    console.error("Toggle Availability Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Toggle Recommended — scoped by restaurant
const toggleRecommendation = async (req, res) => {
  try {
    if (badId(req.params.id, res)) return;
    const restaurantId = req.user.restaurantId;
    const menu = await Menu.findOne({ _id: req.params.id, restaurantId });

    if (!menu) {
      return res.status(404).json({ success: false, message: "Menu item not found" });
    }

    menu.isRecommended = !menu.isRecommended;
    await menu.save();

    return res.status(200).json({
      success: true,
      message: `Menu item ${menu.isRecommended ? "recommended" : "not recommended"}`,
      data: menu,
    });
  } catch (error) {
    console.error("Toggle Recommendation Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = {
  createMenu,
  getAdminMenus,
  getPublicMenus,
  getMenuById,
  getMenusByCategory,
  updateMenu,
  deleteMenu,
  toggleAvailability,
  toggleRecommendation,
};