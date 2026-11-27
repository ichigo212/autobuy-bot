const { Schema, model, models } = require("mongoose");

// Redeemable balance codes (gift cards / promo codes). Created by staff via
// /createcoupon and claimed by users via /redeem.
const couponSchema = new Schema({
  guildId: { type: String, required: true, index: true },

  // The code users type to redeem. Stored uppercased for case-insensitive match.
  code: { type: String, required: true },

  // Balance granted per successful redemption.
  amount: { type: Number, required: true },

  // How many times the coupon can be redeemed in total.
  maxUses: { type: Number, default: 1 },
  uses: { type: Number, default: 0 },

  // User IDs that have already redeemed it (one redemption per user).
  redeemedBy: { type: [String], default: [] },

  // Optional expiry. null = never expires.
  expiresAt: { type: Date, default: null },

  createdBy: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

// A coupon code is unique per guild.
couponSchema.index({ guildId: 1, code: 1 }, { unique: true });

const name = "coupon-data";
module.exports = models[name] || model(name, couponSchema);
