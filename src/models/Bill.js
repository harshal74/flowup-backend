const mongoose = require("mongoose");

const billSchema = new mongoose.Schema(
  {
    restaurantId: {
      type: String,
      required: [true, "Restaurant ID is required"],
      trim: true,
      index: true,
    },

    tableNumber: {
      type: Number,
      default: null,
    },

    orderIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Order",
        required: true,
      },
    ],

    items: [
        {
            menuItemId: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "Menu",
            },

            name: {
                type: String,
                default: "",
            },

            quantity: {
                type: Number,
                default: 0,
                min: 0,
            },

            price: {
                type: Number,
                default: 0,
                min: 0,
            },

            total: {
                type: Number,
                default: 0,
                min: 0,
            },
        }
    ],

    subtotal: {
      type: Number,
      required: true,
      default: 0,
    },

    gst: {
      type: Number,
      default: 0,
    },

    // SGST + CGST (stored separately for receipt display).
    // For new bills: sgst + cgst = gst.
    // Legacy bills: sgst and cgst will be 0 (field missing), gst holds total GST.
    sgst: {
      type: Number,
      default: 0,
    },

    cgst: {
      type: Number,
      default: 0,
    },

    discount: {
      type: Number,
      default: 0,
    },

    grandTotal: {
      type: Number,
      required: true,
    },

    paymentStatus: {
      type: String,
      enum: ["Pending", "Paid", "Failed", "Refunded"],
      default: "Pending",
    },

    paymentMethod: {
      type: String,
      enum: ["Cash", "UPI", "Card"],
      default: "UPI",
    },

    invoiceNumber: {
      type: String,
      required: true,
      unique: true,
    },

    paidAt: {
      type: Date,
      default: null,
    },

    // Staff reference — who generated this bill
    generatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for bill history pagination (sorted listing per restaurant)
billSchema.index({ restaurantId: 1, createdAt: -1 });


module.exports =
  mongoose.models.Bill ||
  mongoose.model("Bill", billSchema);