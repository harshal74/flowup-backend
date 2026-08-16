const Category = require("../models/Category");

// Create Category — BUG J FIX: use req.user.restaurantId not req.body
// displayOrder is auto-assigned as max+1
const createCategory = async (req, res) => {
  try {
    // Use authenticated admin's restaurantId — never trust req.body.restaurantId
    const restaurantId = req.user?.restaurantId || req.body.restaurantId;
    const { name, description, image } = req.body;

    if (!restaurantId || !name) {
      return res.status(400).json({
        success: false,
        message: "Category name is required",
      });
    }

    const existingCategory = await Category.findOne({ restaurantId, name: name.trim() });
    if (existingCategory) {
      return res.status(409).json({ success: false, message: "Category already exists" });
    }

    const last = await Category.findOne({ restaurantId })
      .sort({ displayOrder: -1 })
      .select("displayOrder");
    const nextOrder = last ? last.displayOrder + 1 : 1;

    const category = await Category.create({
      restaurantId,
      name:         name.trim(),
      description:  description || "",
      image:        image || "",
      displayOrder: nextOrder,
    });

    return res.status(201).json({ success: true, message: "Category created successfully", data: category });
  } catch (error) {
    console.error("Create Category Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Get All Categories
const getCategories = async (req, res) => {
  try {
    const { restaurantId } = req.query;

    const filter = {};

    if (restaurantId) {
      filter.restaurantId = restaurantId;
    }

    const categories = await Category.find(filter)
      .sort({
        displayOrder: 1,
        createdAt: -1,
      });

    return res.status(200).json({
      success: true,
      count: categories.length,
      data: categories,
    });
  } catch (error) {
    console.error("Get Categories Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Get Category By ID
const getCategoryById = async (req, res) => {
  try {
    const { id } = req.params;

    const category = await Category.findById(id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: category,
    });
  } catch (error) {
    console.error("Get Category Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Update Category — BUG 8 FIX: whitelist fields + BUG 11 FIX: new: true
const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;

    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    // Only allow these fields — never let caller change restaurantId
    const { name, description, image, displayOrder, isActive } = req.body;
    const allowedUpdate = {};
    if (name         !== undefined) allowedUpdate.name         = name;
    if (description  !== undefined) allowedUpdate.description  = description;
    if (image        !== undefined) allowedUpdate.image        = image;
    if (displayOrder !== undefined) allowedUpdate.displayOrder = displayOrder;
    if (isActive     !== undefined) allowedUpdate.isActive     = isActive;

    const updatedCategory = await Category.findByIdAndUpdate(
      id,
      allowedUpdate,
      { returnDocument: 'after', runValidators: true }
    );

    return res.status(200).json({ success: true, message: "Category updated successfully", data: updatedCategory });
  } catch (error) {
    console.error("Update Category Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Delete Category
const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;

    const category = await Category.findById(id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    await Category.findByIdAndDelete(id);

    return res.status(200).json({
      success: true,
      message: "Category deleted successfully",
    });
  } catch (error) {
    console.error("Delete Category Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Toggle Category Status
const toggleCategoryStatus = async (req, res) => {
  try {
    const { id } = req.params;

    const category = await Category.findById(id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    category.isActive = !category.isActive;

    await category.save();

    return res.status(200).json({
      success: true,
      message: `Category ${
        category.isActive ? "activated" : "deactivated"
      } successfully`,
      data: category,
    });
  } catch (error) {
    console.error("Toggle Category Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Bulk reorder — accepts [{ id, displayOrder }, ...] and updates all in one call
const reorderCategories = async (req, res) => {
  try {
    const { orders } = req.body; // Array<{ id: string; displayOrder: number }>

    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({
        success: false,
        message: "orders must be a non-empty array of { id, displayOrder }",
      });
    }

    // Run all updates in parallel
    await Promise.all(
      orders.map(({ id, displayOrder }) =>
        Category.findByIdAndUpdate(id, { displayOrder })
      )
    );

    return res.status(200).json({
      success: true,
      message: "Category order updated",
    });
  } catch (error) {
    console.error("Reorder Categories Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = {
  createCategory,
  getCategories,
  getCategoryById,
  updateCategory,
  deleteCategory,
  toggleCategoryStatus,
  reorderCategories,
};