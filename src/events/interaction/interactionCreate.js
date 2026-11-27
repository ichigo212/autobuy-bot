const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  MessageFlags,
} = require("discord.js");
const { purchaseProduct, replyWithPurchase, MAX_QUANTITY } = require("../../utils/purchase");
const { buildProductEmbed, baseEmbed, success, error, getStock, COLORS } = require("../../utils/embeds");
const { money, bmoney } = require("../../utils/format");
const { buildBuyButton, scheduleRefresh } = require("../../utils/liveEmbeds");
const { generateRecoveryKey, hashKey } = require("../../utils/recovery");
const { updateProduct, findProduct, parseDeliveryButtons } = require("../../utils/products");
const fileStock = require("../../utils/fileStock");
const { isStaff } = require("../../utils/permissions");
const { logEvent } = require("../../utils/logger");
const embedBuilder = require("../../utils/embedBuilder");
const storeSchema = require("../../db/models/storeSchema");
const saleSchema = require("../../db/models/saleSchema");
const recoveryKeySchema = require("../../db/models/recoveryKeySchema");
const userSchema = require("../../db/models/userSchema");
const topupRequestSchema = require("../../db/models/topupRequestSchema");
const stickySchema = require("../../db/models/stickySchema");
const { restick, invalidateStickyCache } = require("../../utils/sticky");
const { renderDashboard, buildCsv } = require("../../utils/analytics");
const { handleNotifyToggle, showReviewModal, submitReview, getStoreStatus, closedText } = require("../../utils/features");
const { stockHash } = require("../../commands/editdelivery");
const announce = require("../../utils/announce");
const topups = require("../../utils/topups");
const topupCommand = require("../../commands/topup");
const helpCommand = require("../../commands/help");
const { AttachmentBuilder } = require("discord.js");

const EPHEMERAL = MessageFlags.Ephemeral;

// Reply or follow up depending on the interaction state, never throwing.
const safeRespond = async (interaction, payload) => {
  try {
    if (interaction.deferred && !interaction.replied) return await interaction.editReply(payload);
    if (interaction.replied) return await interaction.followUp({ ...payload, flags: EPHEMERAL });
    return await interaction.reply({ ...payload, flags: EPHEMERAL });
  } catch (err) {
    if (err?.code !== 10062) console.error("Failed to respond to interaction:", err.message);
  }
};

const denyNonStaff = async (interaction) => {
  if (isStaff(interaction)) return false;
  await safeRespond(interaction, { content: "You don't have permission to do that." });
  return true;
};

// Route table: [type, matcher, handler]. Prefix matchers receive the suffix.
const routes = [
  ["select", "store:buy", (c, i) => handleProductSelect(c, i)],
  ["select", "livestock:buy", (c, i) => showAmountModal(c, i, i.values[0])],
  ["button", /^store:confirm:(.+)$/, (c, i, m) => handlePurchase(c, i, m[1], 1)],
  ["button", /^store:qty:(.+)$/, (c, i, m) => showAmountModal(c, i, m[1])],
  ["button", /^order:copy:(.+)$/, (c, i, m) => handleCopyCodes(c, i, m[1])],
  ["button", "user:reckey", (c, i) => handleGenerateRecoveryKey(c, i)],
  ["button", /^notify:([A-Za-z0-9_-]+)$/, (c, i, m) => handleNotifyToggle(i, m[1])],
  ["button", /^vouch:(#[0-9A-F]+)$/, (c, i, m) => showReviewModal(i, m[1])],
  ["button", "embed:content", (c, i) => openEmbedContentModal(c, i)],
  ["button", "embed:appearance", (c, i) => openEmbedAppearanceModal(c, i)],
  ["button", "embed:addlink", (c, i) => openEmbedAddLinkModal(c, i)],
  ["button", "embed:clearlinks", (c, i) => handleEmbedClearLinks(c, i)],
  ["button", "embed:cancel", (c, i) => handleEmbedCancel(c, i)],
  ["button", "embed:post", (c, i) => handleEmbedPost(c, i)],
  ["select", /^an:v:(\w+)$/, (c, i, m) => handleAnalytics(c, i, m[1], i.values[0])],
  ["button", /^an:[pr]:(\w+):(\w+)$/, (c, i, m) => handleAnalytics(c, i, m[1], m[2])],
  ["button", /^an:csv:(\w+)$/, (c, i, m) => handleAnalyticsCsv(c, i, m[1])],
  ["button", /^topup:approve:([0-9a-f]+)$/, (c, i, m) => handleTopupApprove(c, i, m[1])],
  ["button", /^topup:decline:([0-9a-f]+)$/, (c, i, m) => handleTopupDeclineButton(c, i, m[1])],
  ["button", /^topup:undo:([0-9a-f]+)$/, (c, i, m) => handleTopupUndo(c, i, m[1])],
  ["modal", /^topup:reason:([0-9a-f]+)$/, (c, i, m) => handleTopupDeclineSubmit(c, i, m[1])],
  ["button", "pay:cancel", (c, i) => topupCommand.handlePayButton(c, i, "cancel")],
  ["button", /^pay:done:(\d+):([0-9a-f]+)$/, (c, i, m) => topupCommand.handlePayButton(c, i, "done", Number(m[1]), m[2])],
  ["modal", /^pay:receipt:(\d+):([0-9a-f]+)$/, (c, i, m) => topupCommand.handleReceiptForm(c, i, Number(m[1]), m[2])],
  ["modal", /^buy:amount:(.+)$/, (c, i, m) => handleAmountSubmit(c, i, m[1])],
  ["modal", "embed:content:submit", (c, i) => handleEmbedContentSubmit(c, i)],
  ["modal", "embed:appearance:submit", (c, i) => handleEmbedAppearanceSubmit(c, i)],
  ["modal", "embed:addlink:submit", (c, i) => handleEmbedAddLinkSubmit(c, i)],
  ["modal", /^editstock:submit:(.+)$/, (c, i, m) => handleEditStockSubmit(c, i, m[1])],
  ["modal", /^editdelivery:submit:([A-Za-z0-9_-]+):([0-9a-f]{10})$/, (c, i, m) => handleEditDeliverySubmit(c, i, m[1], m[2])],
  ["modal", /^vouch:submit:(#[0-9A-F]+)$/, (c, i, m) => submitReview(c, i, m[1])],
  ["modal", /^sticky:set:(\d+)$/, (c, i, m) => handleStickySet(c, i, m[1])],
  ["select", "help:section", (c, i) => helpCommand.handleSection(c, i, i.values[0])],
  ["button", "help:home", (c, i) => helpCommand.handleSection(c, i, "home")],
  ["modal", "ann:form", (c, i) => announce.handleFormSubmit(c, i)],
  ["button", "ann:send", (c, i) => announce.handleSend(c, i)],
  ["button", "ann:edit", (c, i) => announce.handleEdit(c, i)],
  ["button", "ann:cancel", (c, i) => announce.handleCancel(c, i)],
  ["button", "ann:stop", (c, i) => announce.handleStop(c, i)],
  ["button", /^ann:mute:(\d+)$/, (c, i, m) => announce.handleMuteToggle(c, i, m[1])],
];

const typeOf = (i) =>
  i.isStringSelectMenu?.() ? "select" : i.isButton?.() ? "button" : i.isModalSubmit?.() ? "modal" : null;

module.exports = async (client, interaction) => {
  const type = typeOf(interaction);

  if (type) {
    // Only order-copy, review and announcement-mute buttons work in DMs; everything else needs a server.
    const dmSafe = /^(order:copy:|vouch:|ann:mute:)/.test(interaction.customId);
    if (!interaction.inGuild() && !dmSafe) return;
    for (const [t, matcher, handler] of routes) {
      if (t !== type) continue;
      const m = typeof matcher === "string" ? (interaction.customId === matcher ? [matcher] : null) : interaction.customId.match(matcher);
      if (!m) continue;
      try {
        await handler(client, interaction, m);
      } catch (err) {
        console.error(`Component ${interaction.customId} failed:`, err);
        await safeRespond(interaction, { content: "Something went wrong. Please try again." });
      }
      return;
    }
    return;
  }

  if (!interaction.isChatInputCommand?.()) return;
  if (!interaction.inGuild()) {
    return interaction.reply({ content: "Please use my commands inside a server.", flags: EPHEMERAL }).catch(() => {});
  }

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.callback(client, interaction);
  } catch (err) {
    console.error(`/${interaction.commandName} failed:`, err);
    await safeRespond(interaction, { content: "Something went wrong running that command." });
  }
};

// ---- Store / buying -----------------------------------------------------------

async function handleProductSelect(client, interaction) {
  const productCode = interaction.values[0];
  const [storeData, user] = await Promise.all([
    storeSchema.findOne({ guildId: interaction.guild.id }),
    userSchema.findOne({ guildId: interaction.guild.id, userId: interaction.user.id }),
  ]);
  const product = storeData?.store.find((p) => p.productCode === productCode);
  if (!product) return interaction.reply({ content: "That product is no longer available.", flags: EPHEMERAL });

  const status = await getStoreStatus(interaction.guild.id);
  return interaction.reply({
    content: status.open ? undefined : closedText(status),
    embeds: [buildProductEmbed(interaction, product, Number(user?.userBalance) || 0)],
    components: status.open ? buildBuyButton(product) : [],
    flags: EPHEMERAL,
  });
}

async function handlePurchase(client, interaction, productCode, quantity) {
  await interaction.deferReply({ flags: EPHEMERAL });
  const result = await purchaseProduct({
    client,
    guildId: interaction.guild.id,
    userId: interaction.user.id,
    productCode,
    quantity,
    guildName: interaction.guild.name,
  });
  return replyWithPurchase(interaction, result);
}

// Quantity picker used by the "Buy more…" button and the live stock board.
async function showAmountModal(client, interaction, productCode) {
  const { product } = await findProduct(interaction.guild.id, productCode);
  if (!product) return interaction.reply({ content: "That product is no longer available.", flags: EPHEMERAL });

  const stock = getStock(product);
  if (stock <= 0) {
    return interaction.reply({ embeds: [buildProductEmbed(interaction, product)], components: buildBuyButton(product), flags: EPHEMERAL });
  }
  const status = await getStoreStatus(interaction.guild.id);
  if (!status.open) return interaction.reply({ content: closedText(status), flags: EPHEMERAL });
  const max = Math.min(stock, MAX_QUANTITY);

  const modal = new ModalBuilder().setCustomId(`buy:amount:${productCode}`).setTitle(`Buy ${product.productName}`.slice(0, 45));
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("amount")
        .setLabel(`How many? (1–${max})`)
        .setPlaceholder(`${money(product.productPrice)} each`.slice(0, 100))
        .setStyle(TextInputStyle.Short)
        .setValue("1")
        .setMinLength(1)
        .setMaxLength(3)
        .setRequired(true)
    )
  );
  return interaction.showModal(modal);
}

async function handleAmountSubmit(client, interaction, productCode) {
  const raw = (interaction.fields.getTextInputValue("amount") || "").trim();
  const qty = Number(raw);
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
    return interaction.reply({ content: `❌ Enter a whole number from 1 to ${MAX_QUANTITY}.`, flags: EPHEMERAL });
  }
  return handlePurchase(client, interaction, productCode, qty);
}

// "Copy item(s)" button on a delivery: only the buyer may reveal them.
async function handleCopyCodes(client, interaction, orderId) {
  const sale = await saleSchema.findOne({ orderId });
  if (!sale) return interaction.reply({ content: "That order could not be found.", flags: EPHEMERAL });
  if (sale.userId !== interaction.user.id) return interaction.reply({ content: "This order isn't yours.", flags: EPHEMERAL });
  if (sale.refunded) return interaction.reply({ content: "This order was refunded, so its items are no longer available.", flags: EPHEMERAL });

  const codes = sale.deliveredCodes?.length ? sale.deliveredCodes : sale.deliveredCode ? [sale.deliveredCode] : [];
  if (codes.length === 0) return interaction.reply({ content: "This order has no items to copy.", flags: EPHEMERAL });

  const block = codes.join("\n");
  return interaction.reply({
    content: `Order \`${orderId}\` — tap the block to copy:\n\`\`\`\n${block.slice(0, 1850)}\n\`\`\`${block.length > 1850 ? "\n*(Too long to show in full — see the invoice file.)*" : ""}`,
    flags: EPHEMERAL,
  });
}

// "Generate recovery key" on /user. Only a hash is stored; the raw key is shown
// once (never put in a button id, so it isn't kept in the message data).
async function handleGenerateRecoveryKey(client, interaction) {
  const guildId = interaction.guild.id;
  const rawKey = generateRecoveryKey();
  await recoveryKeySchema.findOneAndUpdate(
    { guildId, userId: interaction.user.id },
    { $set: { keyHash: hashKey(rawKey), createdAt: new Date().toISOString() } },
    { upsert: true }
  );

  const embed = baseEmbed(interaction)
    .setColor(COLORS.success)
    .setTitle("🔐 Your Balance Recovery Key")
    .setDescription(
      [
        "Save this somewhere safe (a password manager or a note only you can see).",
        "If you lose this Discord account, run `/recoverbalance use` on your new account to move your balance over.",
        "",
        "⚠️ **Anyone with this key can take your balance — treat it like a password.**",
        "Generating a new key makes the old one stop working.",
      ].join("\n")
    );
  return interaction.reply({ content: `\`\`\`\n${rawKey}\n\`\`\``, embeds: [embed], flags: EPHEMERAL });
}

// ---- Analytics dashboard (staff) ------------------------------------------------

async function handleAnalytics(client, interaction, period, view) {
  if (await denyNonStaff(interaction)) return;
  await interaction.deferUpdate();
  return interaction.editReply(await renderDashboard(interaction, interaction.guild.id, period, view));
}

async function handleAnalyticsCsv(client, interaction, period) {
  if (await denyNonStaff(interaction)) return;
  await interaction.deferReply({ flags: EPHEMERAL });
  const { csv, count, label } = await buildCsv(interaction.guild.id, period);
  if (!count) return interaction.editReply({ content: `No sales in **${label}** to export.` });
  return interaction.editReply({
    content: `📄 **${count}** sale(s) — ${label}. Open it with Excel or Google Sheets.`,
    files: [new AttachmentBuilder(Buffer.from("﻿" + csv, "utf8"), { name: `sales-${period}-${new Date().toISOString().slice(0, 10)}.csv` })],
  });
}

// ---- Embed builder ---------------------------------------------------------------

const isHttpUrl = (u) => /^https?:\/\/\S+$/i.test(u);

async function requireDraft(interaction) {
  if (await denyNonStaff(interaction)) return null;
  const draft = embedBuilder.getDraft(interaction.user.id);
  if (!draft) {
    await safeRespond(interaction, { content: "Your embed draft expired — run `/embed` again to start over." });
    return null;
  }
  return draft;
}

const input = (id, label, style, { value, max, required = false, placeholder } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required);
  if (max) t.setMaxLength(max);
  if (value) t.setValue(String(value).slice(0, max || 4000));
  if (placeholder) t.setPlaceholder(placeholder);
  return new ActionRowBuilder().addComponents(t);
};

async function openEmbedContentModal(client, interaction) {
  const draft = await requireDraft(interaction);
  if (!draft) return;
  const modal = new ModalBuilder().setCustomId("embed:content:submit").setTitle("Edit embed content");
  modal.addComponents(
    input("title", "Title", TextInputStyle.Short, { value: draft.title, max: 256 }),
    input("description", "Description", TextInputStyle.Paragraph, { value: draft.description, max: 4000 }),
    input("author", "Author line (small text above the title)", TextInputStyle.Short, { value: draft.author, max: 256 })
  );
  return interaction.showModal(modal);
}

async function openEmbedAppearanceModal(client, interaction) {
  const draft = await requireDraft(interaction);
  if (!draft) return;
  const modal = new ModalBuilder().setCustomId("embed:appearance:submit").setTitle("Edit embed appearance");
  modal.addComponents(
    input("color", "Color hex (e.g. #5865F2)", TextInputStyle.Short, { value: draft.color, max: 7 }),
    input("image", "Large image URL (https://…)", TextInputStyle.Short, { value: draft.imageUrl }),
    input("thumbnail", "Thumbnail URL (https://…)", TextInputStyle.Short, { value: draft.thumbnailUrl }),
    input("footer", "Footer text", TextInputStyle.Short, { value: draft.footer, max: 2048 })
  );
  return interaction.showModal(modal);
}

async function openEmbedAddLinkModal(client, interaction) {
  const draft = await requireDraft(interaction);
  if (!draft) return;
  if ((draft.links || []).length >= 5) return interaction.reply({ content: "You can add at most 5 link buttons.", flags: EPHEMERAL });
  const modal = new ModalBuilder().setCustomId("embed:addlink:submit").setTitle("Add a link button");
  modal.addComponents(
    input("label", "Button label (e.g. Join our server)", TextInputStyle.Short, { max: 80, required: true }),
    input("url", "URL (https://…)", TextInputStyle.Short, { required: true })
  );
  return interaction.showModal(modal);
}

async function handleEmbedContentSubmit(client, interaction) {
  const draft = await requireDraft(interaction);
  if (!draft) return;
  draft.title = interaction.fields.getTextInputValue("title") || "";
  draft.description = interaction.fields.getTextInputValue("description") || "";
  draft.author = interaction.fields.getTextInputValue("author") || "";
  embedBuilder.setDraft(interaction.user.id, draft);
  return interaction.update(embedBuilder.renderPreview(draft));
}

async function handleEmbedAppearanceSubmit(client, interaction) {
  const draft = await requireDraft(interaction);
  if (!draft) return;
  const image = (interaction.fields.getTextInputValue("image") || "").trim();
  const thumb = (interaction.fields.getTextInputValue("thumbnail") || "").trim();
  const bad = [image, thumb].filter((u) => u && !isHttpUrl(u));
  if (bad.length) {
    return interaction.reply({ content: `❌ Image links must start with \`https://\` — check: ${bad.map((b) => `\`${b.slice(0, 80)}\``).join(", ")}`, flags: EPHEMERAL });
  }
  draft.color = (interaction.fields.getTextInputValue("color") || "").trim();
  draft.imageUrl = image;
  draft.thumbnailUrl = thumb;
  draft.footer = interaction.fields.getTextInputValue("footer") || "";
  embedBuilder.setDraft(interaction.user.id, draft);
  return interaction.update(embedBuilder.renderPreview(draft));
}

async function handleEmbedAddLinkSubmit(client, interaction) {
  const draft = await requireDraft(interaction);
  if (!draft) return;
  const label = (interaction.fields.getTextInputValue("label") || "").trim();
  const url = (interaction.fields.getTextInputValue("url") || "").trim();
  if (!isHttpUrl(url)) return interaction.reply({ content: "❌ That URL is invalid — it must start with `http://` or `https://`.", flags: EPHEMERAL });
  draft.links = [...(draft.links || []), { label, url }].slice(0, 5);
  embedBuilder.setDraft(interaction.user.id, draft);
  return interaction.update(embedBuilder.renderPreview(draft));
}

async function handleEmbedClearLinks(client, interaction) {
  const draft = await requireDraft(interaction);
  if (!draft) return;
  draft.links = [];
  embedBuilder.setDraft(interaction.user.id, draft);
  return interaction.update(embedBuilder.renderPreview(draft));
}

async function handleEmbedCancel(client, interaction) {
  embedBuilder.clearDraft(interaction.user.id);
  return interaction.update({ content: "Embed draft discarded.", embeds: [], components: [] });
}

async function handleEmbedPost(client, interaction) {
  const draft = await requireDraft(interaction);
  if (!draft) return;
  if (!draft.title && !draft.description && !draft.imageUrl && !draft.thumbnailUrl) {
    return interaction.reply({ content: "Add some content first (a title, description, or image) before posting.", flags: EPHEMERAL });
  }
  try {
    const channel = await client.channels.fetch(draft.channelId);
    await channel.send({ embeds: [embedBuilder.buildEmbedFromDraft(draft)], components: embedBuilder.buildLinkRows(draft) });
  } catch (err) {
    console.error("Embed post failed:", err.message);
    return interaction.reply({ content: "I couldn't post the embed there — check my permissions in that channel.", flags: EPHEMERAL });
  }
  embedBuilder.clearDraft(interaction.user.id);
  return interaction.update({ content: `✅ Posted your embed to <#${draft.channelId}>.`, embeds: [], components: [] });
}

// ---- Guided stock / delivery editing (staff) -------------------------------------

async function handleEditStockSubmit(client, interaction, code) {
  if (await denyNonStaff(interaction)) return;
  await interaction.deferReply({ flags: EPHEMERAL });

  const { product } = await findProduct(interaction.guild.id, code);
  if (!product) return interaction.editReply({ embeds: [error(interaction, `Product \`${code}\` no longer exists.`)] });

  const priceRaw = (interaction.fields.getTextInputValue("price") || "").trim();
  const newCodes = fileStock.parseCodes(interaction.fields.getTextInputValue("codes") || "");

  const updates = {};
  if (priceRaw !== "") {
    const price = Number(priceRaw);
    if (!Number.isFinite(price) || price < 0) return interaction.editReply({ embeds: [error(interaction, "Price must be a non-negative number.")] });
    if (price !== Number(product.productPrice)) updates.productPrice = price;
  }

  if (!Object.keys(updates).length && !newCodes.length) {
    return interaction.editReply({ embeds: [success(interaction, "No changes were made.")] });
  }

  const result = await updateProduct({ guildId: interaction.guild.id, productCode: code, updates, ...(newCodes.length ? { newCodes } : {}) });
  if (!result.ok) return interaction.editReply({ embeds: [error(interaction, result.message)] });

  scheduleRefresh(client, interaction.guild.id);
  logEvent(client, interaction.guild.id, {
    type: "stock",
    title: "Stock Edited",
    actorId: interaction.user.id,
    description: `**${result.product.productName}** — price ${bmoney(result.product.productPrice)}, stock **${result.product.productStock}**.`,
  });
  return interaction.editReply({
    embeds: [success(interaction, `Updated **${result.product.productName}** — price ${bmoney(result.product.productPrice)}, stock **${result.product.productStock}**.`)],
  });
}

async function handleEditDeliverySubmit(client, interaction, code, openHash) {
  if (await denyNonStaff(interaction)) return;
  await interaction.deferReply({ flags: EPHEMERAL });

  const guildId = interaction.guild.id;
  const { product } = await findProduct(guildId, code);
  if (!product) return interaction.editReply({ embeds: [error(interaction, `Product \`${code}\` no longer exists.`)] });

  const submittedCodes = fileStock.parseCodes(interaction.fields.getTextInputValue("codes") || "");
  const description = interaction.fields.getTextInputValue("description") ?? "";
  const deliveryMessage = interaction.fields.getTextInputValue("deliverymessage") ?? "";
  const buttonsRaw = interaction.fields.getTextInputValue("buttons") ?? "";

  // Items are replaced only if staff actually edited the field. "Edited" is
  // judged against the list shown when the form OPENED (openHash), not the live
  // file — otherwise a sale made while the form was open would put the sold
  // item back on sale. Blank always means "keep".
  const currentCodes = await fileStock.readCodes(guildId, code);
  const codesEdited = submittedCodes.length > 0 && stockHash(submittedCodes) !== openHash;
  if (codesEdited && stockHash(currentCodes) !== openHash) {
    return interaction.editReply({
      embeds: [error(interaction, "Stock changed while you had the form open (someone bought or staff restocked), so I didn't touch the items. Run `/editdelivery` again to edit the current list.")],
    });
  }
  const codesChanged = codesEdited;

  const updates = {};
  if (description !== (product.description || "")) updates.description = description;
  if (deliveryMessage !== (product.deliveryMessage || "")) updates.deliveryMessage = deliveryMessage;

  let buttonWarnings = [];
  const currentStr = (product.deliveryButtons || []).map((b) => `${b.label} | ${b.url}`).join("\n");
  if (buttonsRaw.trim() !== currentStr.trim()) {
    const { buttons, errors } = parseDeliveryButtons(buttonsRaw);
    buttonWarnings = errors;
    updates.deliveryButtons = buttons;
  }

  if (!codesChanged && !Object.keys(updates).length) {
    return interaction.editReply({ embeds: [success(interaction, "No changes were made.")] });
  }

  const result = await updateProduct({ guildId, productCode: code, updates, ...(codesChanged ? { newCodes: submittedCodes } : {}) });
  if (!result.ok) return interaction.editReply({ embeds: [error(interaction, result.message)] });

  scheduleRefresh(client, guildId);

  const parts = [];
  if (codesChanged) parts.push(`Stock now holds **${result.product.productStock}** item(s).`);
  if (updates.deliveryMessage != null) parts.push("Delivery message updated.");
  if (updates.description != null) parts.push("Description updated.");
  if (updates.deliveryButtons) parts.push(updates.deliveryButtons.length ? `**${updates.deliveryButtons.length}** link button(s) set.` : "Link buttons cleared.");
  const warn = buttonWarnings.length ? `\n\n⚠️ ${buttonWarnings.join("\n⚠️ ")}` : "";

  logEvent(client, guildId, { type: "stock", title: "Delivery Edited", actorId: interaction.user.id, description: `**${result.product.productName}** — ${parts.join(" ")}` });
  return interaction.editReply({ embeds: [success(interaction, `Updated delivery for **${result.product.productName}**. ${parts.join(" ")}${warn}`)] });
}

// ---- Top-up approve / decline (staff) ----------------------------------------------
// The request is claimed atomically (pending → processing) so two staff clicking
// at once can never double-credit. If crediting fails it goes back to pending.
async function handleTopupApprove(client, interaction, requestId) {
  if (await denyNonStaff(interaction)) return;
  await interaction.deferUpdate();
  const r = await topups.decideTopup({ requestId, guildId: interaction.guild.id, approve: true, decidedBy: interaction.user.id });
  if (!r.ok) return interaction.followUp({ content: alreadyText(r.existing), flags: EPHEMERAL }).catch(() => {});
  await finishTopupDecision(client, interaction, r, true, "");
}

// Decline opens a short form: the reason is DMed to the buyer. It starts from what the
// receipt check found (when it found something), and staff can edit or clear it.
async function handleTopupDeclineButton(client, interaction, requestId) {
  if (await denyNonStaff(interaction)) return;
  const req = await topupRequestSchema.findOne({ requestId, guildId: interaction.guild.id });
  if (!req || req.status !== "pending") return interaction.reply({ content: alreadyText(req), flags: EPHEMERAL });
  const input = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("Reason (sent to the buyer, optional)")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(300)
    .setPlaceholder("e.g. Receipt amount doesn't match, or Ref No. not found");
  const first = req.checkVerdict === "check" ? (req.checkReasons || [])[0] : null;
  if (first) input.setValue(String(first).slice(0, 300));
  return interaction.showModal(
    new ModalBuilder().setCustomId(`topup:reason:${requestId}`).setTitle("Decline top-up").addComponents(new ActionRowBuilder().addComponents(input))
  );
}

async function handleTopupDeclineSubmit(client, interaction, requestId) {
  if (await denyNonStaff(interaction)) return;
  if (interaction.isFromMessage?.()) await interaction.deferUpdate();
  else await interaction.deferReply({ flags: EPHEMERAL });
  const reason = (interaction.fields.getTextInputValue("reason") || "").trim().slice(0, 300);
  const r = await topups.decideTopup({ requestId, guildId: interaction.guild.id, approve: false, decidedBy: interaction.user.id });
  if (!r.ok) return interaction.followUp({ content: alreadyText(r.existing), flags: EPHEMERAL }).catch(() => {});
  if (reason) await topupRequestSchema.updateOne({ requestId }, { $set: { reason } }).catch(() => {});
  await finishTopupDecision(client, interaction, r, false, reason);
}

const alreadyText = (existing) =>
  existing
    ? `This top-up was already **${existing.status}**${existing.decidedBy ? ` by ${/^\d+$/.test(existing.decidedBy) ? `<@${existing.decidedBy}>` : existing.decidedBy}` : ""}.`
    : "This top-up no longer exists.";

async function finishTopupDecision(client, interaction, r, approving, reason) {
  const req = r.request;
  if (interaction.message?.embeds?.length) {
    const embed = topups.restyle(interaction.message, {
      color: approving ? COLORS.success : COLORS.error,
      status: approving ? `✅ Approved by <@${interaction.user.id}>` : `✖️ Declined by <@${interaction.user.id}>`,
      extraFields: [
        ...(approving ? [{ name: "👛 New balance", value: bmoney(r.newBalance), inline: true }] : []),
        ...(!approving && reason ? [{ name: "📝 Reason", value: reason.slice(0, 1024) }] : []),
      ],
    });
    const components = approving ? [topupUndoRow(req.requestId)] : [];
    await interaction.editReply({ embeds: [embed], components }).catch((err) => console.error("Top-up message edit failed:", err.message));
  } else {
    await interaction.editReply({ content: approving ? "Approved." : "Declined." }).catch(() => {});
  }

  if (approving) scheduleRefresh(client, req.guildId, { store: false, leaderboard: true });
  logEvent(client, req.guildId, {
    type: "topup",
    title: approving ? "Top-up Approved" : "Top-up Declined",
    userId: req.userId,
    actorId: interaction.user.id,
    fields: [
      { name: "Amount", value: bmoney(req.amount), inline: true },
      { name: "Request", value: `\`${req.requestId}\``, inline: true },
      ...(req.reference ? [{ name: "GCash Ref", value: `\`${req.reference}\``, inline: true }] : []),
      ...(r.newBalance != null ? [{ name: "New balance", value: bmoney(r.newBalance), inline: true }] : []),
      ...(reason ? [{ name: "Reason", value: reason }] : []),
    ],
  });

  try {
    const buyer = await client.users.fetch(req.userId);
    const dm = approving
      ? success({ guild: interaction.guild }, `Your top-up of ${bmoney(req.amount)} was **approved**! New balance: ${bmoney(r.newBalance)}.\nUse \`/store\` to start shopping.`)
      : error(
          { guild: interaction.guild },
          `Your top-up of ${bmoney(req.amount)} was **declined**.${reason ? `\n**Reason:** ${reason}` : ""}\nIf you think this is a mistake, contact staff (request \`${req.requestId}\`).`
        );
    await buyer.send({ embeds: [dm.setTitle(approving ? "🧾 Top-up approved" : "🧾 Top-up declined")] });
  } catch {
    /* DMs closed */
  }
}

const topupUndoRow = (requestId) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`topup:undo:${requestId}`).setLabel("Undo (take it back)").setStyle(ButtonStyle.Secondary).setEmoji("↩️")
  );

// ↩️ Undo on an approved top-up (fake receipt): takes the money back off the buyer's balance.
async function handleTopupUndo(client, interaction, requestId) {
  if (await denyNonStaff(interaction)) return;
  await interaction.deferUpdate();
  const r = await topups.reverseTopup({ requestId, guildId: interaction.guild.id, by: interaction.user.id });
  if (!r.ok) {
    const s = r.existing?.status;
    return interaction
      .followUp({ content: s === "reversed" ? "This top-up was already taken back." : `Can't undo: this top-up is **${s || "gone"}**.`, flags: EPHEMERAL })
      .catch(() => {});
  }
  const embed = topups.restyle(interaction.message, {
    color: COLORS.muted,
    status: `↩️ Taken back by <@${interaction.user.id}>`,
    extraFields: [{ name: "👛 New balance", value: `${bmoney(r.newBalance)}${r.newBalance < 0 ? " ⚠️ (they already spent it)" : ""}`, inline: true }],
  });
  await interaction.editReply({ embeds: [embed], components: [] }).catch((err) => console.error("Top-up message edit failed:", err.message));
  scheduleRefresh(client, interaction.guild.id, { store: false, leaderboard: true });
  logEvent(client, interaction.guild.id, {
    type: "topup",
    title: "Top-up Taken Back",
    userId: r.request.userId,
    actorId: interaction.user.id,
    fields: [
      { name: "Amount", value: bmoney(r.request.amount), inline: true },
      { name: "Request", value: `\`${requestId}\``, inline: true },
      { name: "New balance", value: bmoney(r.newBalance), inline: true },
    ],
  });
  try {
    const buyer = await client.users.fetch(r.request.userId);
    await buyer.send({
      embeds: [
        error(
          { guild: interaction.guild },
          `Your top-up of ${bmoney(r.request.amount)} was **reversed** by staff after checking the receipt. Contact staff if you think this is a mistake (request \`${requestId}\`).`
        ).setTitle("🧾 Top-up reversed"),
      ],
    });
  } catch {
    /* DMs closed */
  }
}

// ---- Sticky message form (staff) ---------------------------------------------------
async function handleStickySet(client, interaction, channelId) {
  if (await denyNonStaff(interaction)) return;
  await interaction.deferReply({ flags: EPHEMERAL });

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.guildId !== interaction.guild.id) {
    return interaction.editReply({ embeds: [error(interaction, "That channel no longer exists.")] });
  }
  if (!channel.permissionsFor(interaction.guild.members.me)?.has(["SendMessages", "ViewChannel", "EmbedLinks"])) {
    return interaction.editReply({ embeds: [error(interaction, `I can't post embeds in ${channel}. Fix my permissions and try again.`)] });
  }

  const content = interaction.fields.getTextInputValue("content");
  await stickySchema.findOneAndUpdate(
    { guildId: interaction.guild.id, channelId },
    { $set: { content }, $setOnInsert: { guildId: interaction.guild.id, channelId } },
    { upsert: true }
  );
  invalidateStickyCache();
  await restick(client, channel);

  return interaction.editReply({ embeds: [success(interaction, `Sticky message set for ${channel}. It will stay at the bottom of the channel.`)] });
}
