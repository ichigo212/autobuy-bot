const { EmbedBuilder } = require("discord.js");
const config = require("../config");
const { money, bmoney, ts, stockBadge, clip } = require("./format");

// ---------------------------------------------------------------------------
// Shared embed theme. Every embed the bot sends goes through these helpers so
// the whole bot looks consistent: brand colour, server icon in the footer,
// timestamp, and status colours for success / error / warning.
// ---------------------------------------------------------------------------

const COLORS = {
  brand: config.color,
  success: "#57F287",
  error: "#ED4245",
  warning: "#FEE75C",
  info: "#5865F2",
  muted: "#2B2D31",
};

const DIVIDER = "▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬";

// `ctx` is anything with a .guild (an interaction, or { guild }), or null.
const baseEmbed = (ctx) => {
  const guild = ctx?.guild;
  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setFooter({ text: guild?.name ? `${config.brand} • ${guild.name}` : config.brand, iconURL: guild?.iconURL?.() || undefined })
    .setTimestamp();
};

const success = (ctx, description) => baseEmbed(ctx).setColor(COLORS.success).setDescription(`✅ ${description}`);
const error = (ctx, description) => baseEmbed(ctx).setColor(COLORS.error).setDescription(`❌ ${description}`);
const warning = (ctx, description) => baseEmbed(ctx).setColor(COLORS.warning).setDescription(`⚠️ ${description}`);
const info = (ctx, description) => baseEmbed(ctx).setDescription(description);

const getStock = (product) => {
  const n = Number(product?.productStock);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// "2" before "10": compare product codes like numbers when they are numbers.
const byCode = (a, b) => String(a.productCode).localeCompare(String(b.productCode), undefined, { numeric: true, sensitivity: "base" });

// ---- Grouping ------------------------------------------------------------------
// Products are shown in groups, each in product-code order. A product's group is
// its `category` (set with /category) or, when it has none, worked out from its
// name: "2x 1 Month Server Boost" and "14x 1 Month Server boost" share a group
// because they differ only by the "Nx" count in front.
const QTY_PREFIX = /^\s*\d+\s*[x×]\s+/i;
const autoKey = (name) =>
  String(name || "")
    .replace(QTY_PREFIX, "")
    .toLowerCase()
    .replace(/(\d+)\s*(months?|mos?|m)\b/g, "$1m")
    .replace(/[^a-z0-9]/g, "");
const prettyGroup = (name) =>
  String(name || "")
    .replace(QTY_PREFIX, "")
    .replace(/\b(\d+)\s*(?:months?|mos?|m)\b/gi, (_, n) => `${n} Month${Number(n) === 1 ? "" : "s"}`)
    .replace(/\S+/g, (w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .trim();

// → [{ name, products }] — name is null when the list has no groups at all.
const groupProducts = (products) => {
  const list = [...(products || [])].sort(byCode);
  const groups = new Map();
  for (const p of list) {
    const cat = String(p.category || "").trim();
    const key = cat ? `c:${cat.toLowerCase()}` : `a:${autoKey(p.productName)}`;
    if (!groups.has(key)) groups.set(key, { name: cat || prettyGroup(p.productName), explicit: !!cat, products: [] });
    groups.get(key).products.push(p);
  }
  // An auto group of one isn't a group — those go together under "Other".
  const real = [...groups.values()].filter((g) => g.explicit || g.products.length > 1);
  if (!real.length) return [{ name: null, products: list }];
  const loose = [...groups.values()].filter((g) => !real.includes(g)).flatMap((g) => g.products).sort(byCode);
  const out = real.sort((a, b) => byCode(a.products[0], b.products[0])).map(({ name, products }) => ({ name, products }));
  if (loose.length) out.push({ name: "Other", products: loose });
  return out;
};

// Group order, then product-code order inside each group.
const sortProducts = (products) => groupProducts(products).flatMap((g) => g.products);

// One product as a line: `1` · **Name** — **20 Php** · 🟢 61 in stock
const productLine = (p) =>
  `\`${p.productCode}\` · ${p.emoji ? `${p.emoji} ` : ""}**${p.productName}** — ${bmoney(p.productPrice)} · ${stockBadge(getStock(p))}` +
  (p.description ? `\n-# ${clip(p.description, 90)}` : "");

// Add the grouped product list to an embed as fields (one per group, split when
// a group is longer than a field allows). Max 25 fields per embed.
const addProductFields = (embed, products) => {
  const groups = groupProducts(products);
  let fields = embed.data.fields?.length || 0;
  let shown = 0;
  for (const g of groups) {
    const icon = g.products.find((p) => p.emoji)?.emoji || "📦";
    const inStock = g.products.filter((p) => getStock(p) > 0).length;
    const title = g.name ? `${icon} ${g.name}  ·  ${inStock}/${g.products.length} available` : "🛍️ Products";
    let chunk = "";
    let first = true;
    const flush = () => {
      if (!chunk || fields >= 24) return;
      embed.addFields({ name: clip(first ? title : "​", 256), value: chunk });
      fields++;
      first = false;
      chunk = "";
    };
    for (const p of g.products) {
      const line = clip(productLine(p), 1000);
      if (chunk.length + line.length + 1 > 1024) flush();
      if (fields >= 24) break;
      chunk += (chunk ? "\n" : "") + line;
      shown++;
    }
    flush();
  }
  const total = groups.reduce((s, g) => s + g.products.length, 0);
  if (shown < total) embed.addFields({ name: "…and more", value: `**${total - shown}** more product(s). Use \`/stock buy <code>\` to buy any product by its code.` });
  return embed;
};

// The store listing used by /store, /stock list, /setupstore and custom shops.
const buildStoreEmbed = (ctx, products, title, description, status) => {
  const guild = ctx?.guild;
  const embed = baseEmbed(ctx).setTitle(title || `🛒 ${guild?.name ? `${guild.name} Store` : "Store"}`);
  if (config.iconUrl || guild?.iconURL?.()) embed.setThumbnail(config.iconUrl || guild.iconURL());
  if (config.bannerUrl) embed.setImage(config.bannerUrl);

  const list = sortProducts(products);
  if (list.length === 0) {
    return embed.setDescription("🛍️ The store is empty right now — check back soon!");
  }

  const totalStock = list.reduce((sum, p) => sum + getStock(p), 0);
  const inStock = list.filter((p) => getStock(p) > 0).length;
  embed.setDescription(
    [
      description || "Pick a product from the menu below to see details and buy instantly. Items are delivered to your DMs automatically.",
      "",
      `📦 **${list.length}** products · 🟢 **${inStock}** available · **${totalStock.toLocaleString("en-US")}** items in stock`,
      status && !status.open ? `\n🔒 **STORE CLOSED** — buying is paused.${status.message ? `\n> ${status.message}` : ""}` : null,
    ]
      .filter((l) => l !== null)
      .join("\n")
  );
  if (status && !status.open) embed.setColor(COLORS.error);

  return addProductFields(embed, list);
};

// The detail view shown when a buyer picks a product, before confirming.
const buildProductEmbed = (ctx, product, balance) => {
  const stock = getStock(product);
  const embed = baseEmbed(ctx)
    .setTitle(`${product.emoji ? `${product.emoji} ` : ""}${product.productName}`)
    .setDescription(
      [product.description ? `>>> ${product.description}` : "Ready to purchase.", ""].join("\n")
    )
    .addFields(
      { name: "💵 Price", value: bmoney(product.productPrice), inline: true },
      { name: "📦 Stock", value: stockBadge(stock), inline: true },
      { name: "🏷️ Code", value: `\`${product.productCode}\``, inline: true }
    );
  if (config.iconUrl) embed.setThumbnail(config.iconUrl);
  if (balance != null) {
    const enough = balance >= Number(product.productPrice || 0);
    embed.addFields({
      name: "👛 Your balance",
      value: `${bmoney(balance)}${enough ? "" : ` — you need ${bmoney(Number(product.productPrice) - balance)} more. Use \`/topup\`.`}`,
    });
  }
  return embed;
};

// The receipt sent to the buyer by DM (and shown as a fallback in-channel).
const buildReceiptEmbed = (ctx, { product, price, newBalance, codes = [], orderId, quantity = 1 }) => {
  const embed = baseEmbed(ctx)
    .setColor(COLORS.success)
    .setAuthor({ name: "Order complete — thank you!" })
    .setTitle(`🧾 ${product.emoji ? `${product.emoji} ` : ""}${product.productName}`)
    .addFields(
      { name: "Order ID", value: `\`${orderId}\``, inline: true },
      { name: "Quantity", value: `×${quantity}`, inline: true },
      { name: "Total paid", value: bmoney(price), inline: true },
      { name: "Balance left", value: bmoney(newBalance), inline: true },
      { name: "Date", value: ts(new Date(), "f"), inline: true }
    );

  if (codes.length > 0) {
    const joined = codes.join("\n");
    const shown = joined.length > 950 ? `${joined.slice(0, 950)}\n…` : joined;
    embed.addFields({
      name: codes.length > 1 ? `🔑 Your ${codes.length} items` : "🔑 Your item",
      value: `\`\`\`\n${shown}\n\`\`\``,
    });
    if (shown !== joined) embed.addFields({ name: "​", value: "📎 The full list is in the attached invoice file." });
  }
  embed.setFooter({ text: `${config.brand} • Keep your Order ID for support` });
  return embed;
};

module.exports = {
  COLORS,
  DIVIDER,
  baseEmbed,
  success,
  error,
  warning,
  info,
  buildStoreEmbed,
  buildProductEmbed,
  buildReceiptEmbed,
  getStock,
  sortProducts,
  groupProducts,
  addProductFields,
  byCode,
  stockBadge,
  money,
};
