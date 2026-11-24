const mongoose = require("mongoose");

const splitItemSchema = new mongoose.Schema(
  {
    menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: "Menu" },
    name:       { type: String, default: "" },
    quantity:   { type: Number, default: 0, min: 0 },
    price:      { type: Number, default: 0, min: 0 },
    total:      { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

// One person's share of a split bill. _id is kept so each split can be
// confirmed individually (PATCH /api/billing/:billId/splits/:splitId/confirm).
const splitSchema = new mongoose.Schema({
  label:         { type: String, default: "", trim: true, maxlength: 40 },
  items:         { type: [splitItemSchema], default: [] }, // BY_ITEM only
  subtotal:      { type: Number, default: 0 },
  sgst:          { type: Number, default: 0 },
  cgst:          { type: Number, default: 0 },
  gst:           { type: Number, default: 0 },
  discount:      { type: Number, default: 0 },
  amount:        { type: Number, required: true, min: 0 }, // final payable for this split
  paymentMethod: { type: String, enum: ["Cash", "UPI", "Card"], default: "Cash" },
  paymentStatus: { type: String, enum: ["Pending", "Paid"], default: "Pending" },
  paidAt:        { type: Date, default: null },
});

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

    // ── Split billing ───────────────────────────────────────────
    // NONE = classic single payment (existing behaviour).
    // With a split, each part is paid separately; the bill (and its orders)
    // only becomes Paid once every split is Paid.
    splitType: {
      type: String,
      enum: ["NONE", "EQUAL", "BY_ITEM", "CUSTOM"],
      default: "NONE",
    },

    splits: [splitSchema],

    // Running settlement totals. Legacy bills: paidAmount 0, remainingAmount unset.
    paidAmount: {
      type: Number,
      default: 0,
    },

    remainingAmount: {
      type: Number,
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