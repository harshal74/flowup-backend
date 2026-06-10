const mongoose = require("mongoose");

const adminSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: String,
      required: [true, "Restaurant ID is required"],
      unique: true,
      trim: true,
      index: true,
    },

    restaurantName: {
      type: String,
      required: [true, "Restaurant name is required"],
      trim: true,
      maxlength: 100,
    },

    name: {
      type: String,
      required: [true, "Admin name is required"],
      trim: true,
      maxlength: 50,
    },

    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },

    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: 6,
      select: false,
    },

    mobile: {
      type: String,
      required: [true, "Mobile number is required"],
      trim: true,
      index: true,
    },

    role: {
      type: String,
      enum: ["ADMIN", "SUPER_ADMIN"],
      default: "ADMIN",
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    lastLogin: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes
adminSchema.index({
  restaurantId: 1,
  email: 1,
});

module.exports =
  mongoose.models.Admin ||
  mongoose.model("Admin", adminSchema);