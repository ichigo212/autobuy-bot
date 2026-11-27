const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require("discord.js");
const config = require("../config");
const { baseEmbed, success, COLORS } = require("./embeds");
const { bmoney } = require("./format");
const guildConfigSchema = require("../db/models/guildConfigSchema");
const restockAlertSchema = require("../db/models/restockAlertSchema");
const saleSchema = require("../db/models/saleSchema");

const EPHEMERAL = MessageFlags.Ephemeral;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Store open / closed -------------------------------------------------------

// { open: boolean, message: string }. Defaults to open.
const getStoreStatus = async (guildId) => {
  const cfg = await guildConfigSchema.findOne({ guildId }).lean();
  return { open: cfg?.storeOpen !== false, message: cfg?.storeClosedMessage || "" };
};

const closedText = (status) =>
  `🔒 **The store is closed right now.**${status.message ? `\n> ${status.message}` : ""}\nYou can still top up and check your balance.`;

// ---- Customer role ---------------------------------------------------------------

// Give the configured "Customer" role after a purchase (best-effort; needs the
// bot's role to be above it and the Manage Roles permission).
const grantCustomerRole = async (client, guildId, userId) => {
  try {
    const cfg = await guildConfigSchema.findOne({ guildId }).lean();
    if (!cfg?.customerRoleId) return;
    const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId));
    const member = await guild.members.fetch(userId);
    if (!member.roles.cache.has(cfg.customerRoleId)) await member.roles.add(cfg.customerRoleId, "Made a purchase");
  } catch (err) {
    console.error("Customer role grant failed:", err.message);
  }
};

// ---- Restock alerts --------------------------------------------------------------

const notifyButton = (productCode) =>
  new ButtonBuilder().setCustomId(`notify:${productCode}`).setLabel("Notify me when restocked").setEmoji("🔔").setStyle(ButtonStyle.Primary);

// Toggle a user's restock alert for a product (button handler).
const handleNotifyToggle = async (interaction, productCode) => {
  const filter = { guildId: interaction.guild.id, productCode, userId: interaction.user.id };
  const removed = await restockAlertSchema.findOneAndDelete(filter);
  if (removed) {
    return interaction.reply({ content: "🔕 OK — you won't be notified for this product anymore.", flags: EPHEMERAL });
  }
  await restockAlertSchema.updateOne(filter, { $setOnInsert: filter }, { upsert: true });
  return interaction.reply({
    content: "🔔 Got it! I'll DM you as soon as this product is back in stock. (Tap the button again to cancel.)",
    flags: EPHEMERAL,
  });
};

// DM everyone waiting on a product, then clear their alerts.
const notifyRestock = async (client, { guildId, productCode, stock }) => {
  const subs = await restockAlertSchema.find({ guildId, productCode }).lean();
  if (!subs.length) return;

  const storeSchema = require("../db/models/storeSchema");
  const product = (await storeSchema.findOne({ guildId }).lean())?.store?.find((p) => p.productCode === productCode);
  if (!product) return;
  const guild = client.guilds.cache.get(guildId);
  const cfg = await guildConfigSchema.findOne({ guildId }).lean();
  const storeLink = cfg?.storeChannelId && cfg?.storeMessageId ? `https://discord.com/channels/${guildId}/${cfg.storeChannelId}/${cfg.storeMessageId}` : null;

  const embed = baseEmbed({ guild })
    .setColor(COLORS.success)
    .setTitle("🔔 Back in stock!")
    .setDescription(
      `**${product.emoji ? `${product.emoji} ` : ""}${product.productName}** is available again in **${guild?.name || "the store"}** — ${bmoney(product.productPrice)} each, **${stock}** in stock.\nBe quick, it may sell out again!`
    );
  const components = storeLink
    ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Go to the store").setURL(storeLink))]
    : [];

  for (const sub of subs) {
    try {
      const user = await client.users.fetch(sub.userId);
      await user.send({ embeds: [embed], components });
    } catch {
      /* DMs closed */
    }
    await restockAlertSchema.deleteOne({ _id: sub._id });
    await sleep(400); // stay well under Discord's DM rate limits
  }
};

// ---- Reviews / vouches -----------------------------------------------------------

const reviewButtonRow = (orderId) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vouch:${orderId}`).setLabel("Leave a review").setEmoji("⭐").setStyle(ButtonStyle.Success)
  );

// Is a reviews channel configured for this guild?
const reviewsEnabled = async (guildId) => Boolean((await guildConfigSchema.findOne({ guildId }).lean())?.vouchChannelId);

const showReviewModal = async (interaction, orderId) => {
  const sale = await saleSchema.findOne({ orderId }).lean();
  if (!sale || sale.userId !== interaction.user.id) return interaction.reply({ content: "This order isn't yours.", flags: EPHEMERAL });
  if (sale.reviewed) return interaction.reply({ content: "You already reviewed this order — thank you! 💙", flags: EPHEMERAL });

  const modal = new ModalBuilder().setCustomId(`vouch:submit:${orderId}`).setTitle("Leave a review");
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("rating").setLabel("Rating (1 to 5 stars)").setStyle(TextInputStyle.Short).setValue("5").setMinLength(1).setMaxLength(1).setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("text")
        .setLabel("Your review")
        .setPlaceholder("e.g. Fast delivery, legit seller!")
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(500)
        .setRequired(true)
    )
  );
  return interaction.showModal(modal);
};

const submitReview = async (client, interaction, orderId) => {
  const rating = Number((interaction.fields.getTextInputValue("rating") || "").trim());
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return interaction.reply({ content: "❌ The rating must be a number from 1 to 5.", flags: EPHEMERAL });
  }
  const text = interaction.fields.getTextInputValue("text").trim();

  // Claim the review atomically (one per order).
  const sale = await saleSchema.findOneAndUpdate(
    { orderId, userId: interaction.user.id, reviewed: { $ne: true } },
    { $set: { reviewed: true, rating } },
    { new: true }
  );
  if (!sale) return interaction.reply({ content: "You already reviewed this order — thank you! 💙", flags: EPHEMERAL });

  const cfg = await guildConfigSchema.findOne({ guildId: sale.guildId }).lean();
  const channel = cfg?.vouchChannelId ? await client.channels.fetch(cfg.vouchChannelId).catch(() => null) : null;
  if (!channel?.isTextBased?.()) {
    await saleSchema.updateOne({ orderId }, { $set: { reviewed: false } });
    return interaction.reply({ content: "Reviews aren't set up in that server right now. Thanks anyway! 💙", flags: EPHEMERAL });
  }

  const embed = baseEmbed({ guild: channel.guild })
    .setColor(rating >= 4 ? COLORS.success : rating === 3 ? COLORS.warning : COLORS.error)
    .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
    .setTitle(`${"⭐".repeat(rating)}${"☆".repeat(5 - rating)}`)
    .setDescription(`>>> ${text}`)
    .addFields(
      { name: "Bought", value: `${sale.productName} ×${sale.quantity || 1}`, inline: true },
      { name: "Buyer", value: `<@${interaction.user.id}>`, inline: true },
      { name: "Verified", value: "✅ Real order", inline: true }
    );
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });

  return interaction.reply({ embeds: [success(null, `Thanks for the ${rating}★ review! It's been posted in **${channel.guild.name}**.`)], flags: EPHEMERAL });
};

module.exports = {
  getStoreStatus,
  closedText,
  grantCustomerRole,
  notifyButton,
  handleNotifyToggle,
  notifyRestock,
  reviewButtonRow,
  reviewsEnabled,
  showReviewModal,
  submitReview,
};
