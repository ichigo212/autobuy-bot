const config = require("../config");

// Format an amount with the configured currency.
//   CURRENCY=credits → "1,250 credits"
//   CURRENCY=₱ / $   → "₱1,250"  (short symbols are prefixed)
const money = (amount) => {
  const n = Number(amount) || 0;
  const num = n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const cur = config.currency;
  const isSymbol = cur.length <= 2 && !/[a-z]/i.test(cur);
  return isSymbol ? `${cur}${num}` : `${num} ${cur}`;
};

// Real pesos (GCash amounts), whatever the shop's balance currency is called.
const peso = (amount) => `₱${(Number(amount) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

// Bold money, the most common way it's shown in embeds.
const bmoney = (amount) => `**${money(amount)}**`;

// Discord timestamp markup. style: R (relative), f (short date/time), F, d, t.
const ts = (date, style = "R") => `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;

// Stock badge used across the store, product and live-stock embeds.
const stockBadge = (stock) => {
  if (stock <= 0) return "🔴 Sold out";
  if (stock <= config.lowStockThreshold) return `🟠 Only ${stock} left`;
  return `🟢 ${stock.toLocaleString("en-US")} in stock`;
};

// Turn a stored product emoji into something Discord accepts on a button or
// select option, or null. Supports custom emoji (<:name:id> / <a:name:id>) and
// unicode emoji, including multi-codepoint ones (❤️, 🇵🇭, 👨‍💻).
const componentEmoji = (raw) => {
  if (!raw) return null;
  const s = String(raw).trim();
  const custom = s.match(/^<(a?):(\w{2,32}):(\d{17,20})>$/);
  if (custom) return { animated: custom[1] === "a", name: custom[2], id: custom[3] };
  if (s.length <= 16 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s) && !/[a-z0-9\s]/i.test(s)) {
    return { name: s };
  }
  return null;
};

// Keep text within a Discord limit, adding an ellipsis when cut.
const clip = (text, max) => {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

module.exports = {
  peso, money, bmoney, ts, stockBadge, componentEmoji, clip };
