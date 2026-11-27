const { ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const config = require("../config");
const { COLORS, baseEmbed, buildStoreEmbed, getStock, sortProducts, addProductFields } = require("./embeds");
const { money, bmoney, stockBadge, componentEmoji, clip } = require("./format");
const { notifyButton, getStoreStatus } = require("./features");

const storeSchema = require("../db/models/storeSchema");
const userSchema = require("../db/models/userSchema");
const guildConfigSchema = require("../db/models/guildConfigSchema");

// ---- Components --------------------------------------------------------------

const productOption = (p) => {
  const stock = getStock(p);
  const option = {
    label: clip(p.productName, 100),
    description: clip(
      stock > 0 ? `${money(p.productPrice)} • ${stock} in stock${p.description ? ` • ${p.description}` : ""}` : `🔴 Sold out — tap to get notified when it's back`,
      100
    ),
    value: p.productCode,
  };
  const emoji = componentEmoji(p.emoji);
  if (emoji) option.emoji = emoji;
  return option;
};

// Select menu for buying from a store / shop embed. customId routes the pick.
// In-stock products come first; sold-out ones are listed too so buyers can ask
// to be notified on restock. Hidden entirely while the store is closed.
const buildStoreComponents = (products, customId = "store:buy", status) => {
  if (status && !status.open) return [];
  const inStock = sortProducts(products);
  if (inStock.length === 0) return [];
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder("🛒 Select a product to buy…")
    .addOptions(inStock.slice(0, 25).map(productOption));
  return [new ActionRowBuilder().addComponents(menu)];
};

// Buttons on a product's detail view: buy one, or pick a quantity.
const buildBuyButton = (product) => {
  const stock = getStock(product);
  const buy = new ButtonBuilder()
    .setCustomId(`store:confirm:${product.productCode}`)
    .setLabel(stock > 0 ? `Buy 1 • ${money(product.productPrice)}` : "Sold out")
    .setStyle(stock > 0 ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setDisabled(stock <= 0);
  const emoji = componentEmoji(product.emoji);
  if (emoji) buy.setEmoji(emoji);

  const row = new ActionRowBuilder().addComponents(buy);
  if (stock <= 0) row.addComponents(notifyButton(product.productCode));
  if (stock > 1) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`store:qty:${product.productCode}`)
        .setLabel("Buy more…")
        .setEmoji("🔢")
        .setStyle(ButtonStyle.Primary)
    );
  }
  return [row];
};

// Delivery-DM components: a copy button plus staff-configured link buttons.
const buildDeliveryComponents = ({ orderId, buttons } = {}) => {
  const rows = [];
  if (orderId) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`order:copy:${orderId}`).setLabel("Copy item(s)").setEmoji("📋").setStyle(ButtonStyle.Secondary)
      )
    );
  }
  const links = (buttons || []).filter((b) => b && b.label && /^https?:\/\//i.test(b.url)).slice(0, 5);
  if (links.length) {
    rows.push(
      new ActionRowBuilder().addComponents(
        links.map((b) => new ButtonBuilder().setLabel(clip(b.label, 80)).setStyle(ButtonStyle.Link).setURL(b.url))
      )
    );
  }
  return rows;
};

// ---- Leaderboard -------------------------------------------------------------

const buildLeaderboardEmbed = async (guild) => {
  const top = await userSchema.find({ guildId: guild.id, userBalance: { $gt: 0 } }).sort({ userBalance: -1 }).limit(10);
  const embed = baseEmbed({ guild }).setColor(COLORS.warning).setTitle("🏆 Balance Leaderboard");
  if (guild.iconURL()) embed.setThumbnail(guild.iconURL());

  if (top.length === 0) return embed.setDescription("No one has a balance yet. Be the first — use `/topup`!");

  const medals = ["🥇", "🥈", "🥉"];
  const lines = top.map((u, i) => `${medals[i] || `\`#${i + 1}\``} <@${u.userId}> — ${bmoney(u.userBalance)}`);
  return embed.setDescription(lines.join("\n")).setFooter({ text: `${config.brand} • Top 10 • Updates live` });
};

// ---- Live stock board --------------------------------------------------------

const buildLiveStockEmbed = (ctx, products) => {
  const guild = ctx?.guild ?? ctx;
  const embed = baseEmbed({ guild }).setTitle("📦 Live Stock").setFooter({ text: `${config.brand} • Updates automatically`, iconURL: guild?.iconURL?.() || undefined });

  const list = sortProducts(products);
  if (list.length === 0) return embed.setDescription("🛍️ No products in the store yet.");

  const total = list.reduce((s, p) => s + getStock(p), 0);
  const inStock = list.filter((p) => getStock(p) > 0).length;
  embed.setDescription(
    `📦 **${list.length}** products · 🟢 **${inStock}** available · **${total.toLocaleString("en-US")}** items in stock\nPick a product below to buy — you'll choose the amount next.`
  );
  return addProductFields(embed, list);
};

const buildLiveStockComponents = (products, status) => buildStoreComponents(products, "livestock:buy", status);

// ---- In-place refreshers -----------------------------------------------------
// Each refresher swallows its own errors: a deleted message or Discord hiccup
// must never break the purchase / edit that triggered it.

const editMessage = async (client, channelId, messageId, payloadFn) => {
  try {
    const channel = await client.channels.fetch(channelId);
    const message = await channel.messages.fetch(messageId);
    await message.edit(await payloadFn(channel));
  } catch {
    /* message deleted or inaccessible */
  }
};

const refreshStoreMessage = async (client, guildId) => {
  try {
    const cfg = await guildConfigSchema.findOne({ guildId });
    if (!cfg?.storeChannelId || !cfg?.storeMessageId) return;
    const products = (await storeSchema.findOne({ guildId }))?.store || [];
    const status = await getStoreStatus(guildId);
    await editMessage(client, cfg.storeChannelId, cfg.storeMessageId, (channel) => ({
      embeds: [buildStoreEmbed({ guild: channel.guild }, products, undefined, undefined, status)],
      components: buildStoreComponents(products, "store:buy", status),
    }));
  } catch (err) {
    console.error("refreshStoreMessage:", err.message);
  }
};

const refreshShopMessages = async (client, guildId) => {
  try {
    const cfg = await guildConfigSchema.findOne({ guildId });
    if (!cfg?.shops?.length) return;
    const all = (await storeSchema.findOne({ guildId }))?.store || [];
    const status = await getStoreStatus(guildId);
    for (const shop of cfg.shops) {
      if (!shop.channelId || !shop.messageId) continue;
      const products = shop.productCodes?.length ? all.filter((p) => shop.productCodes.includes(p.productCode)) : all;
      await editMessage(client, shop.channelId, shop.messageId, (channel) => ({
        embeds: [buildStoreEmbed({ guild: channel.guild }, products, `🛒 ${shop.name}`, shop.description || undefined, status)],
        components: buildStoreComponents(products, "store:buy", status),
      }));
    }
  } catch (err) {
    console.error("refreshShopMessages:", err.message);
  }
};

const refreshLiveStockMessage = async (client, guildId) => {
  try {
    const cfg = await guildConfigSchema.findOne({ guildId });
    if (!cfg?.liveStockChannelId || !cfg?.liveStockMessageId) return;
    const products = (await storeSchema.findOne({ guildId }))?.store || [];
    const status = await getStoreStatus(guildId);
    await editMessage(client, cfg.liveStockChannelId, cfg.liveStockMessageId, (channel) => ({
      embeds: [buildLiveStockEmbed({ guild: channel.guild }, products)],
      components: buildLiveStockComponents(products, status),
    }));
  } catch (err) {
    console.error("refreshLiveStockMessage:", err.message);
  }
};

const refreshLeaderboardMessage = async (client, guildId) => {
  try {
    const cfg = await guildConfigSchema.findOne({ guildId });
    if (!cfg?.leaderboardChannelId || !cfg?.leaderboardMessageId) return;
    await editMessage(client, cfg.leaderboardChannelId, cfg.leaderboardMessageId, async (channel) => ({
      embeds: [await buildLeaderboardEmbed(channel.guild)],
    }));
  } catch (err) {
    console.error("refreshLeaderboardMessage:", err.message);
  }
};

// Debounced background refresh. Call it after anything that changes products,
// stock or balances; bursts within ~1.5s collapse into one round of edits, and
// the caller never waits on (or fails because of) Discord message edits.
const pending = new Map(); // guildId -> { timer, store, leaderboard }
const scheduleRefresh = (client, guildId, { store = true, leaderboard = false } = {}) => {
  const entry = pending.get(guildId) || { store: false, leaderboard: false };
  entry.store ||= store;
  entry.leaderboard ||= leaderboard;
  if (!entry.timer) {
    entry.timer = setTimeout(async () => {
      pending.delete(guildId);
      if (entry.store) {
        await refreshStoreMessage(client, guildId);
        await refreshShopMessages(client, guildId);
        await refreshLiveStockMessage(client, guildId);
      }
      if (entry.leaderboard) await refreshLeaderboardMessage(client, guildId);
    }, 1500);
  }
  pending.set(guildId, entry);
};

module.exports = {
  buildStoreComponents,
  buildBuyButton,
  buildDeliveryComponents,
  buildLeaderboardEmbed,
  buildLiveStockEmbed,
  buildLiveStockComponents,
  refreshStoreMessage,
  refreshShopMessages,
  refreshLiveStockMessage,
  refreshLeaderboardMessage,
  scheduleRefresh,
};
