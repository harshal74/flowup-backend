const mongoose = require("mongoose");

const menuSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },

    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    description: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },

    image: {
      type: String,
      default: "",
    },

    price: {
      type: Number,
      required: true,
      min: 0,
    },

    discountedPrice: {
      type: Number,
      default: null,
      min: 0,
    },

    isVeg: {
      type: Boolean,
      default: true,
    },

    isAvailable: {
      type: Boolean,
      default: true,
      index: true,
    },

    isRecommended: {
      type: Boolean,
      default: false,
    },

    preparationTime: {
      type: Number,
      default: 15,
      min: 1,
    },

    displayOrder: {
      type: Number,
      default: 0,
    },

    tags: [
      {
        type: String,
        trim: true,
      },
    ],

    totalOrders: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

menuSchema.index({
  restaurantId: 1,
  categoryId: 1,
});

menuSchema.index({
  restaurantId: 1,
  name: 1,
});

module.exports =
  mongoose.models.Menu ||
  mongoose.model("Menu", menuSchema);