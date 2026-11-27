const crypto = require("crypto");
const {
  ApplicationCommandOptionType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  LabelBuilder,
  FileUploadBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require("discord.js");
const config = require("../config");
const { baseEmbed, error, success, COLORS } = require("../utils/embeds");
const { bmoney, peso } = require("../utils/format");
const { GCASH_BLUE, MAX_RECEIPT_BYTES, autoSettings, submitTopup } = require("../utils/topups");
const guildConfigSchema = require("../db/models/guildConfigSchema");
const topupRequestSchema = require("../db/models/topupRequestSchema");

const EPHEMERAL = MessageFlags.Ephemeral;
const block = (s) => `\`\`\`\n${s}\n\`\`\``;
const bpeso = (amount) => `**${peso(amount)}**`;

// ---------------------------------------------------------------------------
// /topup — GCash top-ups, same flow as the deco site:
//   /topup amount  → GCash details card  [✅ Done, upload receipt] [Cancel]
//   Done           → form: receipt screenshot + Ref No.
//   submit         → receipt check → auto-approved / sent to staff / declined
// ---------------------------------------------------------------------------

// The GCash payment card shown by `/topup` with no amount.
const instructionsEmbed = (ctx) => {
  const { number, name, qrUrl, note } = config.gcash;
  const embed = baseEmbed(ctx)
    .setColor(GCASH_BLUE)
    .setAuthor({ name: "GCash Top-up" })
    .setTitle("💙 Top up with GCash")
    .setDescription(
      [
        "**How it works**",
        "1️⃣ Run `/topup amount:<how much>`.",
        "2️⃣ Send **exactly** that amount to the GCash number shown.",
        "3️⃣ Press **Done**, upload your GCash receipt and type its **Ref No.**",
        "4️⃣ Most receipts are approved **instantly**. Bigger ones are checked by staff.",
      ].join("\n")
    );
  if (number || name) {
    embed.addFields(
      { name: "📱 GCash number", value: number ? block(number) : "—", inline: true },
      { name: "👤 Account name", value: name ? block(name) : "—", inline: true }
    );
  }
  if (note) embed.addFields({ name: "📝 Note", value: note.slice(0, 1024) });
  if (/^https?:\/\/\S+$/i.test(qrUrl)) embed.setImage(qrUrl);
  return embed;
};

// Step 1: where to send the money.
const payMessage = (ctx, amount, nonce) => {
  const { number, name, qrUrl } = config.gcash;
  const embed = baseEmbed(ctx)
    .setColor(GCASH_BLUE)
    .setTitle(`💙 Send ${peso(amount)} with GCash`)
    .setDescription(
      [
        "**1.** In GCash, tap **Send** → **Express Send**.",
        `**2.** Send exactly **${peso(amount)}** to the number below.`,
        "**3.** Screenshot the receipt, then press **Done**: upload it and type the **Ref No.** printed on it.",
      ].join("\n")
    )
    .addFields(
      { name: "📱 GCash number", value: block(number), inline: true },
      { name: "👤 Account name", value: name ? block(name) : "—", inline: true },
      { name: "💵 Amount", value: block(peso(amount)), inline: true }
    )
    .setFooter({ text: `${config.brand} • Only you can see this` });
  if (/^https?:\/\/\S+$/i.test(qrUrl)) embed.setImage(qrUrl);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pay:done:${amount}:${nonce}`).setStyle(ButtonStyle.Success).setLabel("Done, upload receipt").setEmoji("✅"),
    new ButtonBuilder().setCustomId("pay:cancel").setStyle(ButtonStyle.Secondary).setLabel("Cancel")
  );
  return { content: "", embeds: [embed], components: [row] };
};

// Step 2: the receipt form opened by Done.
const receiptModal = (amount, nonce) =>
  new ModalBuilder()
    .setCustomId(`pay:receipt:${amount}:${nonce}`)
    .setTitle(`Receipt for ${peso(amount)}`.slice(0, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("GCash receipt screenshot")
        .setDescription("The GCash screen showing the amount and Ref No.")
        .setFileUploadComponent(new FileUploadBuilder().setCustomId("receipt").setRequired(true).setMinValues(1).setMaxValues(1)),
      new LabelBuilder()
        .setLabel("GCash Ref No.")
        .setDescription("The Ref No. printed on your receipt, numbers only.")
        .setTextInputComponent(
          new TextInputBuilder().setCustomId("reference").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(6).setMaxLength(30).setPlaceholder("e.g. 1012 345 678901")
        )
    );

// Step 3: what the buyer sees afterwards (replaces the GCash card).
const resultMessage = (ctx, res, amount) => {
  if (res.verdict === "auto") {
    return {
      content: "",
      components: [],
      embeds: [
        success(ctx, `Your ${bpeso(amount)} top-up was **approved instantly**!\n👛 New balance: ${bmoney(res.newBalance)}\n\nUse \`/store\` to start shopping.`)
          .setTitle("💙 Top-up approved")
          .addFields({ name: "🆔 Request", value: `\`${res.request.requestId}\``, inline: true }),
      ],
    };
  }
  if (res.verdict === "rejected") {
    return {
      content: "",
      components: [],
      embeds: [error(ctx, `This receipt can't be used: **${res.reasons[0]}**\nIf you think this is a mistake, contact staff.`).setTitle("⛔ Top-up declined")],
    };
  }
  return {
    content: "",
    components: [],
    embeds: [
      baseEmbed(ctx)
        .setColor(COLORS.info)
        .setTitle("📨 Receipt sent to staff")
        .setDescription(`Your ${bpeso(amount)} top-up is waiting for a quick check by staff. You'll get a **DM** as soon as it's approved.`)
        .addFields({ name: "🆔 Request", value: `\`${res.request.requestId}\``, inline: true }, { name: "💵 Amount", value: bpeso(amount), inline: true }),
    ],
  };
};

// Can this user start / continue a top-up here? Returns { cfg, reviewChannel } or { error }.
const gate = async (client, interaction) => {
  const guildId = interaction.guild.id;
  if (!config.gcash.number) return { error: "Top-ups aren't set up yet (no GCash number). Please tell the owner." };
  const cfg = await guildConfigSchema.findOne({ guildId });
  const channelId = cfg?.topupChannelId || cfg?.logChannelId;
  const reviewChannel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
  if (!reviewChannel || !reviewChannel.permissionsFor(interaction.guild.members.me)?.has(["ViewChannel", "SendMessages", "EmbedLinks", "AttachFiles"])) {
    return { error: "Top-ups aren't set up yet (no approval channel, or I can't post there). Please tell an admin to run `/settings approval-channel`." };
  }
  const pending = await topupRequestSchema.countDocuments({ guildId, userId: interaction.user.id, status: "pending" });
  if (pending >= config.maxPendingTopups) {
    return { error: `You already have **${pending}** top-up(s) waiting for staff. Please wait until they're checked.` };
  }
  return { cfg, reviewChannel };
};

// One receipt per GCash card: stops double submits of the same form.
const usedNonces = new Map(); // nonce -> time
const claimNonce = (nonce) => {
  const now = Date.now();
  for (const [n, t] of usedNonces) if (now - t > 6 * 3600 * 1000) usedNonces.delete(n);
  if (usedNonces.has(nonce)) return false;
  usedNonces.set(nonce, now);
  return true;
};

// ---- Component handlers (routed from interactionCreate) ------------------------------

async function handlePayButton(client, i, action, amount, nonce) {
  if (action === "cancel") return i.update({ content: "Top-up cancelled. Run `/topup` again whenever you like.", embeds: [], components: [] });
  if (usedNonces.has(nonce)) return i.reply({ content: "This receipt was already sent. Run `/topup` to start a new top-up.", flags: EPHEMERAL });
  return i.showModal(receiptModal(amount, nonce));
}

async function handleReceiptForm(client, i, amount, nonce) {
  if (i.isFromMessage?.()) await i.deferUpdate();
  else await i.deferReply({ flags: EPHEMERAL });
  const fail = (content) => i.followUp({ content, flags: EPHEMERAL }).catch(() => {});

  let file = null;
  try {
    file = i.fields.getUploadedFiles("receipt")?.first() || null;
  } catch {
    file = null;
  }
  if (!file) return fail("Add your receipt screenshot, then press **Done** again.");
  if (file.size > MAX_RECEIPT_BYTES) return fail("That image is too big. Send a screenshot under 8 MB, then press **Done** again.");
  const reference = String(i.fields.getTextInputValue("reference") || "").replace(/\s+/g, "");
  if (!/^\d{6,20}$/.test(reference)) return fail("Type the **Ref No.** from your receipt (numbers only), then press **Done** again.");

  const g = await gate(client, i);
  if (g.error) return fail(g.error);
  if (!claimNonce(nonce)) return fail("This receipt was already sent. Run `/topup` to start a new top-up.");

  let res;
  try {
    res = await submitTopup({ client, guild: i.guild, user: i.user, amount, attachment: file, typedRef: reference, cfg: g.cfg, reviewChannel: g.reviewChannel });
  } catch (err) {
    usedNonces.delete(nonce);
    console.error("Top-up submit failed:", err);
    return fail("❌ Something went wrong sending your receipt. Press **Done** to try again.");
  }
  if (res.verdict === "error") {
    usedNonces.delete(nonce);
    return fail(`❌ ${res.message} Press **Done** to try again.`);
  }

  if (res.verdict === "auto") {
    i.user
      .send({ embeds: [success({ guild: i.guild }, `Your top-up of ${bpeso(amount)} was **approved**! New balance: ${bmoney(res.newBalance)}.`).setTitle("🧾 Top-up approved")] })
      .catch(() => {});
  }
  return i.editReply(resultMessage(i, res, amount));
}

module.exports = {
  name: "topup",
  category: "Economy",
  description: "Top up your balance with GCash. Run with no amount to see how",
  hidden: false,
  options: [
    { name: "amount", description: "How much to top up (₱)", type: ApplicationCommandOptionType.Integer, required: false, minValue: 1, maxValue: config.maxTopup },
  ],

  callback: async (client, interaction) => {
    const amount = interaction.options.getInteger("amount");
    if (!amount) return interaction.reply({ embeds: [instructionsEmbed(interaction)], flags: EPHEMERAL });

    await interaction.deferReply({ flags: EPHEMERAL });
    const g = await gate(client, interaction);
    if (g.error) return interaction.editReply({ embeds: [error(interaction, g.error)] });

    const auto = autoSettings(g.cfg);
    const payload = payMessage(interaction, amount, crypto.randomBytes(6).toString("hex"));
    if (auto.on && amount <= auto.max) payload.content = "⚡ Receipts that check out are approved **instantly**.";
    else if (auto.on) payload.content = `🕐 Top-ups over **${peso(auto.max)}** are checked by staff, usually within a few minutes.`;
    return interaction.editReply(payload);
  },

  handlePayButton,
  handleReceiptForm,
  instructionsEmbed,
};
