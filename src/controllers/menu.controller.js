const Menu = require("../models/Menu");

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
    const { restaurantId } = req.query;

    const menus = await Menu.find({
      restaurantId,
      isAvailable: true,
    })
      .populate("categoryId", "name")
      .sort({ displayOrder: 1 });

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

// Get Menu By Id
const getMenuById = async (req, res) => {
  try {
    const menu = await Menu.findById(req.params.id)
      .populate("categoryId", "name");

    if (!menu) {
      return res.status(404).json({
        success: false,
        message: "Menu item not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: menu,
    });
  } catch (error) {
    console.error("Get Menu Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Get Menu By Category
const getMenusByCategory = async (req, res) => {
  try {
    const { categoryId } = req.params;

    const menus = await Menu.find({
      categoryId,
      isAvailable: true,
    });

    return res.status(200).json({
      success: true,
      count: menus.length,
      data: menus,
    });
  } catch (error) {
    console.error("Category Menu Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Update Menu Item
const updateMenu = async (req, res) => {
  try {
    const menu = await Menu.findById(req.params.id);

    if (!menu) {
      return res.status(404).json({
        success: false,
        message: "Menu item not found",
      });
    }

    const updatedMenu =
      await Menu.findByIdAndUpdate(
        req.params.id,
        req.body,
        {
          returnDocument: "after",
          runValidators: true,
        }
      );

    return res.status(200).json({
      success: true,
      message: "Menu updated successfully",
      data: updatedMenu,
    });
  } catch (error) {
    console.error("Update Menu Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Delete Menu Item
const deleteMenu = async (req, res) => {
  try {
    const menu = await Menu.findById(req.params.id);

    if (!menu) {
      return res.status(404).json({
        success: false,
        message: "Menu item not found",
      });
    }

    await Menu.findByIdAndDelete(req.params.id);

    return res.status(200).json({
      success: true,
      message: "Menu deleted successfully",
    });
  } catch (error) {
    console.error("Delete Menu Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Toggle Availability
const toggleAvailability = async (req, res) => {
  try {
    const menu = await Menu.findById(req.params.id);

    if (!menu) {
      return res.status(404).json({
        success: false,
        message: "Menu item not found",
      });
    }

    menu.isAvailable = !menu.isAvailable;

    await menu.save();

    return res.status(200).json({
      success: true,
      message: `Menu item ${
        menu.isAvailable
          ? "available"
          : "unavailable"
      } successfully`,
      data: menu,
    });
  } catch (error) {
    console.error("Toggle Availability Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Toggle Recommended
const toggleRecommendation = async (req, res) => {
  try {
    const menu = await Menu.findById(req.params.id);

    if (!menu) {
      return res.status(404).json({
        success: false,
        message: "Menu item not found",
      });
    }

    menu.isRecommended =
      !menu.isRecommended;

    await menu.save();

    return res.status(200).json({
      success: true,
      message: `Menu item ${
        menu.isRecommended
          ? "recommended"
          : "not recommended"
      }`,
      data: menu,
    });
  } catch (error) {
    console.error("Toggle Recommendation Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
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