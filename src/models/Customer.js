const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: String,
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    mobile: {
      type: String,
      required: true,
      trim: true,
    },

    address: {
      type: String,
      default: "",
      trim: true,
    },

    totalOrders: {
      type: Number,
      default: 0,
    },

    totalSpent: {
      type: Number,
      default: 0,
    },

    lastOrderAt: {
      type: Date,
      default: null,
    },

    isBlocked: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

customerSchema.index(
  {
    restaurantId: 1,
    mobile: 1,
  },
  {
    unique: true,
  }
);

module.exports =
  mongoose.models.Customer ||
  mongoose.model("Customer", customerSchema);