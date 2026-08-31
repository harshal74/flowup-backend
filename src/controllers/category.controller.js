const Category = require("../models/Category");
const mongoose = require("mongoose");

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// Create Category
const createCategory = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { name, description, image } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Category name is required" });
    }

    // FIX M4: Case-insensitive duplicate check (anchored, with regex escaping).
    // "Burgers", "burgers", and "BURGERS" are treated as the same category
    // within the same restaurant — consistent with the menu duplicate check.
    const safeName = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const existingCategory = await Category.findOne({
      restaurantId,
      name: { $regex: `^${safeName}$`, $options: "i" },
    });
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

// Get All Categories (public for customer frontend via resolver, admin via token)
const getCategories = async (req, res) => {
  try {
    // Use the resolver-provided restaurantId (already validated)
    const restaurantId = req.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({ success: false, message: "restaurantId is required" });
    }

    const categories = await Category.find({ restaurantId })
      .sort({ displayOrder: 1, createdAt: -1 });

    return res.status(200).json({ success: true, count: categories.length, data: categories });
  } catch (error) {
    console.error("Get Categories Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Get Category By ID — always scoped by restaurant (resolver or JWT)
const getCategoryById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    const restaurantId = req.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({ success: false, message: "restaurantId is required" });
    }

    const category = await Category.findOne({ _id: id, restaurantId });

    if (!category) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    return res.status(200).json({ success: true, data: category });
  } catch (error) {
    console.error("Get Category Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Update Category — scoped by restaurant, whitelisted fields
const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    const restaurantId = req.user.restaurantId;
    const category = await Category.findOne({ _id: id, restaurantId });
    if (!category) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    const { name, description, image, displayOrder, isActive } = req.body;
    const allowedUpdate = {};
    if (name         !== undefined) allowedUpdate.name         = name;
    if (description  !== undefined) allowedUpdate.description  = description;
    if (image        !== undefined) allowedUpdate.image        = image;
    if (displayOrder !== undefined) allowedUpdate.displayOrder = displayOrder;
    if (isActive     !== undefined) allowedUpdate.isActive     = isActive;

    const updatedCategory = await Category.findOneAndUpdate(
      { _id: id, restaurantId },
      allowedUpdate,
      { returnDocument: 'after', runValidators: true }
    );

    return res.status(200).json({ success: true, message: "Category updated successfully", data: updatedCategory });
  } catch (error) {
    console.error("Update Category Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Delete Category — scoped by restaurant
const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    const restaurantId = req.user.restaurantId;
    const deleted = await Category.findOneAndDelete({ _id: id, restaurantId });

    if (!deleted) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    return res.status(200).json({ success: true, message: "Category deleted successfully" });
  } catch (error) {
    console.error("Delete Category Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Toggle Category Status — scoped by restaurant
const toggleCategoryStatus = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    const restaurantId = req.user.restaurantId;
    const category = await Category.findOne({ _id: id, restaurantId });

    if (!category) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    category.isActive = !category.isActive;
    await category.save();

    return res.status(200).json({
      success: true,
      message: `Category ${category.isActive ? "activated" : "deactivated"} successfully`,
      data: category,
    });
  } catch (error) {
    console.error("Toggle Category Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Bulk reorder — scoped by restaurant
const reorderCategories = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { orders } = req.body;

    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ success: false, message: "orders must be a non-empty array of { id, displayOrder }" });
    }

    // Only update categories belonging to this restaurant
    await Promise.all(
      orders.map(({ id, displayOrder }) =>
        Category.findOneAndUpdate({ _id: id, restaurantId }, { displayOrder })
      )
    );

    return res.status(200).json({ success: true, message: "Category order updated" });
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
