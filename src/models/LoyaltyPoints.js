/**
 * LoyaltyPoints — per-customer points ledger.
 *
 * Rules (server-enforced, never from client):
 *   • 1 point per ₹100 spent on a COMPLETED + PAID order.
 *   • Redemption: 1 point = ₹1 discount on next order (min 10 points).
 *   • Max redemption per order: 20% of order total.
 *   • Points expire 1 year after they are earned.
 */

const mongoose = require("mongoose");

const loyaltyTxSchema = new mongoose.Schema({
  type:      { type: String, enum: ["EARN", "REDEEM", "EXPIRE", "ADJUST"], required: true },
  points:    { type: Number, required: true },             // positive = earn, negative = redeem/expire
  orderId:   { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
  note:      { type: String, default: "", maxlength: 200 },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

const loyaltySchema = new mongoose.Schema({
  restaurantId: { type: String, required: true, index: true },
  customerId:   { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },

  balance: { type: Number, default: 0, min: 0 },        // current redeemable balance
  lifetimeEarned:  { type: Number, default: 0 },
  lifetimeRedeemed: { type: Number, default: 0 },

  transactions: { type: [loyaltyTxSchema], default: [] },
}, { timestamps: true });

loyaltySchema.index({ restaurantId: 1, customerId: 1 }, { unique: true });

module.exports =
  mongoose.models.LoyaltyPoints ||
  mongoose.model("LoyaltyPoints", loyaltySchema);
