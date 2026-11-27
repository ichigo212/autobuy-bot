const { Schema, model, models } = require("mongoose");

// Per-guild runtime config: references to the live store/leaderboard messages
// (so they can be edited in place) and any custom shops created via /createshop.
const shopSchema = new Schema(
  {
    name: { type: String, required: true },
    description: { type: String, default: "" },
    // Product codes that belong to this shop. Empty = show everything.
    productCodes: { type: [String], default: [] },
    channelId: { type: String, default: null },
    messageId: { type: String, default: null },
  },
  { _id: false }
);

const guildConfigSchema = new Schema({
  guildId: { type: String, required: true, unique: true },

  // Live "/setupstore" embed location so we can refresh it in place.
  storeChannelId: { type: String, default: null },
  storeMessageId: { type: String, default: null },

  // Live "/setleaderboard" embed location.
  leaderboardChannelId: { type: String, default: null },
  leaderboardMessageId: { type: String, default: null },

  // Channel where sale/refund/redeem log embeds are posted (/setlogchannel).
  logChannelId: { type: String, default: null },

  // Live "/livestock" stock-status embed location.
  liveStockChannelId: { type: String, default: null },
  liveStockMessageId: { type: String, default: null },

  // Channel where GCash top-up requests are posted for staff review (/settopupchannel).
  topupChannelId: { type: String, default: null },

  // Analytics reset point. When set, /analytics only counts sales made at or
  // after this timestamp — a non-destructive way to "zero out" the reported
  // profit/revenue figures without deleting any sale history. Cleared by
  // /resetanalytics undo, which restores the full history.
  analyticsResetAt: { type: Date, default: null },

  // Post a summary of yesterday's sales to the log channel every night.
  dailyReport: { type: Boolean, default: false },
  lastDailyReport: { type: String, default: null }, // "YYYY-MM-DD" already posted

  // Store switch (/settings store). Closed = nobody can buy.
  storeOpen: { type: Boolean, default: true },
  storeClosedMessage: { type: String, default: "" },

  // Reviews / vouches channel and the role given after a purchase (/settings).
  vouchChannelId: { type: String, default: null },
  customerRoleId: { type: String, default: null },

  // A notification for every sale (/settings sales-channel). Private staff channel.
  salesChannelId: { type: String, default: null },

  // GCash receipt auto-approve (/settings auto-approve). Amounts in whole pesos.
  autoApprove: { type: Boolean, default: true },
  autoApproveMax: { type: Number, default: 1000 },
  receiptMaxAgeMin: { type: Number, default: 120 },

  // Extra bot admins added with /announcement addowner. Users and roles here
  // get owner + staff access in this server (main owners stay in OWNER_IDS).
  adminUserIds: { type: [String], default: [] },
  adminRoleIds: { type: [String], default: [] },

  shops: { type: [shopSchema], default: [] },
});

const name = "guild-config";
module.exports = models[name] || model(name, guildConfigSchema);
