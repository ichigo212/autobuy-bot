// Central config. Values are read from env so nothing sensitive is hardcoded.
// OWNER_IDS / STAFF_ROLE_IDS are comma-separated lists in .env.

const parseList = (value) =>
  (value || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const int = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const hex = (value, fallback) => (/^#?[0-9a-f]{6}$/i.test(value || "") ? (value.startsWith("#") ? value : `#${value}`) : fallback);

module.exports = {
  // Discord user IDs that count as bot owners (full admin over every command).
  ownerIds: parseList(process.env.OWNER_IDS),

  // Role IDs that may run "Staff" gated commands. Members with Manage Server
  // also pass the staff check (see utils/permissions).
  staffRoleIds: parseList(process.env.STAFF_ROLE_IDS),

  // Currency label shown throughout the bot (e.g. "credits", "PHP", "₱", "$").
  currency: process.env.CURRENCY || "credits",

  // Branding.
  brand: process.env.BRAND || "AutoBuy",
  color: hex(process.env.EMBED_COLOR, "#5865F2"),
  iconUrl: process.env.ICON_URL || "",
  // Optional wide banner image shown at the bottom of the store embed.
  bannerUrl: process.env.BANNER_URL || "",

  // GCash top-ups. /topup shows these as a payment card; buyers then submit a
  // receipt screenshot that staff approve or decline.
  topupMethod: "GCash",
  gcash: {
    number: process.env.GCASH_NUMBER || "",
    name: process.env.GCASH_NAME || "",
    // Optional: a direct image link to your GCash QR code (https://…png/jpg).
    qrUrl: process.env.GCASH_QR_URL || "",
    // Optional extra note, e.g. "Rate: ₱1 = 1 credit • Min ₱20". Use \n for new lines.
    note: (process.env.GCASH_NOTE || "").replace(/\\n/g, "\n"),
  },
  maxTopup: int(process.env.MAX_TOPUP, 1000000),
  maxPendingTopups: int(process.env.MAX_PENDING_TOPUPS, 3),

  // Timezone used for "today", daily charts and the nightly report.
  timezone: process.env.TIMEZONE || "Asia/Manila",

  // Stock at or below this is shown as "low" and triggers a staff alert.
  lowStockThreshold: int(process.env.LOW_STOCK_THRESHOLD, 3),
};
