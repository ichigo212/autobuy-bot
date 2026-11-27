const { Schema, model, models } = require("mongoose");

// One document per completed sale. Powers /analytics.
const saleSchema = new Schema({
  guildId: { type: String, required: true, index: true },
  userId: { type: String, required: true },

  // Human-friendly invoice / order id shown to the buyer and staff. Unique per
  // sale so an order can be looked up and refunded by id.
  orderId: { type: String, unique: true, sparse: true },

  productCode: { type: String, required: true },
  productName: { type: String, required: true },
  // Total charged for the order, and the per-unit price at the time of sale.
  price: { type: Number, required: true },
  unitPrice: { type: Number, default: null },

  // Cost and profit per unit snapshotted at sale time (profit = unitPrice − cost),
  // so changing a product's price or cost later never rewrites past analytics.
  // null = no cost configured for the product when it sold.
  costPerUnit: { type: Number, default: null },
  profitPerUnit: { type: Number, default: null },

  // How many units this order delivered. Defaults to 1 for legacy sales.
  quantity: { type: Number, default: 1 },

  // "code" (inline code delivery) or "file" (legacy .txt delivery).
  deliveryType: { type: String, default: "code" },

  // The exact code(s) delivered (for code sales). Lets /refund restore them to
  // stock. deliveredCode keeps the first code for backwards compatibility.
  deliveredCode: { type: String, default: null },
  deliveredCodes: { type: [String], default: undefined },

  // Whether delivery DM succeeded — a failed DM still counts as a sale but is
  // flagged so staff can follow up.
  delivered: { type: Boolean, default: true },

  // Refund tracking. A refunded sale is excluded from revenue analytics.
  refunded: { type: Boolean, default: false },
  refundedBy: { type: String, default: null },
  refundedAt: { type: Date, default: null },
  // Whether a refund put the items back into stock.
  restocked: { type: Boolean, default: false },

  // Buyer review (/settings reviews-channel). One per order.
  reviewed: { type: Boolean, default: false },
  rating: { type: Number, default: null },

  createdAt: { type: Date, default: Date.now, index: true },
});

const name = "sale-data";
module.exports = models[name] || model(name, saleSchema);
