const { Schema, model, models } = require("mongoose");

// One-off business costs (ads, bulk stock purchases, fees…) logged with
// /expense. Subtracted from gross profit in /analytics to give net profit.
const expenseSchema = new Schema({
  guildId: { type: String, required: true, index: true },
  expenseId: { type: String, required: true }, // short id shown to staff, e.g. "A1B2C3"
  amount: { type: Number, required: true },
  note: { type: String, default: "" },
  createdBy: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, index: true },
});

expenseSchema.index({ guildId: 1, expenseId: 1 }, { unique: true });

const name = "expense-data";
module.exports = models[name] || model(name, expenseSchema);
