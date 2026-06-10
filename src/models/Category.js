const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema(
  {
    restaurantId: {
      type: String,
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: [true, "Category name is required"],
      trim: true,
      maxlength: 50,
    },

    description: {
      type: String,
      trim: true,
      maxlength: 200,
      default: "",
    },

    image: {
      type: String,
      default: "",
    },

    displayOrder: {
      type: Number,
      default: 0,
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Prevent duplicate category names within a restaurant
categorySchema.index(
  {
    restaurantId: 1,
    name: 1,
  },
  {
    unique: true,
  }
);

module.exports =
  mongoose.models.Category ||
  mongoose.model("Category", categorySchema);