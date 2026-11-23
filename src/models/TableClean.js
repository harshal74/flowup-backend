/**
 * TableClean
 *
 * One record per cleaning cycle of a dine-in table.
 * Lifecycle: DIRTY -> CLEANING -> CLEAN
 *
 * `active` is true while status is DIRTY or CLEANING. A partial unique index on
 * (restaurantId, tableNumber) where active === true guarantees at most one
 * active cycle per table, even under concurrent requests. CLEAN records are
 * kept as history (active = false).
 */

const mongoose = require("mongoose");

const staffRefSchema = new mongoose.Schema(
  {
    staffId: { type: mongoose.Schema.Types.ObjectId, default: null },
    name:    { type: String, default: "", trim: true, maxlength: 100 },
    role:    { type: String, default: "", trim: true, maxlength: 20 },
  },
  { _id: false }
);

const tableCleanSchema = new mongoose.Schema(
  {
    restaurantId: { type: String, required: true, trim: true },
    tableNumber:  { type: Number, required: true, min: 1 },

    // Order (and bill) that made the table dirty. Informational only.
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    billId:  { type: mongoose.Schema.Types.ObjectId, ref: "Bill",  default: null },

    status: {
      type: String,
      enum: ["DIRTY", "CLEANING", "CLEAN"],
      default: "DIRTY",
      required: true,
    },

    active: { type: Boolean, default: true },

    dirtyAt: { type: Date, default: Date.now },

    cleaningBy:        { type: staffRefSchema, default: null },
    cleaningStartedAt: { type: Date, default: null },

    cleanedBy: { type: staffRefSchema, default: null },
    cleanedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// At most one active (DIRTY/CLEANING) record per table per restaurant.
tableCleanSchema.index(
  { restaurantId: 1, tableNumber: 1 },
  { unique: true, partialFilterExpression: { active: true } }
);

// Active list / history queries
tableCleanSchema.index({ restaurantId: 1, active: 1, status: 1 });
tableCleanSchema.index({ restaurantId: 1, createdAt: -1 });

module.exports =
  mongoose.models.TableClean || mongoose.model("TableClean", tableCleanSchema);
