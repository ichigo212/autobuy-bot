const { Schema, model, models } = require("mongoose");

// "Notify me when it's back" subscriptions. One row per (guild, product, user);
// removed once the user has been notified.
const restockAlertSchema = new Schema({
  guildId: { type: String, required: true },
  productCode: { type: String, required: true },
  userId: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

restockAlertSchema.index({ guildId: 1, productCode: 1, userId: 1 }, { unique: true });

const name = "restock-alert";
module.exports = models[name] || model(name, restockAlertSchema);
