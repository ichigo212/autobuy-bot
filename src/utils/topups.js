const crypto = require("crypto");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, EmbedBuilder } = require("discord.js");
const config = require("../config");
const { baseEmbed, COLORS } = require("./embeds");
const { bmoney, clip } = require("./format");
const { logEvent } = require("./logger");
const { scheduleRefresh } = require("./liveEmbeds");
const { judge, parseReceipt, getReader, imageType, php } = require("./receiptCheck");
const topupRequestSchema = require("../db/models/topupRequestSchema");
const userSchema = require("../db/models/userSchema");

// ---------------------------------------------------------------------------
// GCash top-ups: receipt check → auto-approve / staff review / auto-decline,
// plus the shared credit + undo logic used by the buttons.
//
// Statuses: pending → processing → approved | declined;  approved → reversing → reversed (Undo).
// ---------------------------------------------------------------------------

const GCASH_BLUE = "#007DFE";
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;

// Owner settings (per server, /settings auto-approve). Amounts are whole pesos.
const autoSettings = (cfg) => ({
  on: cfg?.autoApprove !== false,
  max: Number.isFinite(cfg?.autoApproveMax) ? cfg.autoApproveMax : 1000,
  maxAgeMin: Number.isFinite(cfg?.receiptMaxAgeMin) ? cfg.receiptMaxAgeMin : 120,
});

// One check-and-save at a time, so two buyers can never both claim the same Ref No.
let lock = Promise.resolve();
const exclusive = (fn) => {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
};

// Status of the "best" earlier top-up with this Ref No. / image, across every server
// (a GCash receipt is only worth its money once, wherever it was used).
const PRIORITY = { approved: 0, processing: 1, pending: 2, reversing: 3, reversed: 4, declined: 5 };
const statusOf = async (field, value) => {
  if (!value) return null;
  const docs = await topupRequestSchema.find({ [field]: value });
  if (!docs.length) return null;
  docs.sort((a, b) => (PRIORITY[a.status] ?? 9) - (PRIORITY[b.status] ?? 9));
  return docs[0].status;
};

// ---- Credit / decline / undo -----------------------------------------------------

// Claim pending → processing, credit (when approving), then finalise.
// Returns { ok: true, request, newBalance } or { ok: false, existing } if someone else decided first.
async function decideTopup({ requestId, guildId, approve, decidedBy }) {
  const claimed = await topupRequestSchema.findOneAndUpdate(
    { requestId, guildId, status: "pending" },
    { $set: { status: "processing", decidedBy } },
    { new: true }
  );
  if (!claimed) return { ok: false, existing: await topupRequestSchema.findOne({ requestId }) };

  let newBalance = null;
  if (approve) {
    try {
      const updated = await userSchema.findOneAndUpdate(
        { guildId: claimed.guildId, userId: claimed.userId },
        { $inc: { userBalance: claimed.amount }, $setOnInsert: { guildId: claimed.guildId, userId: claimed.userId } },
        { upsert: true, new: true }
      );
      newBalance = updated.userBalance;
    } catch (err) {
      await topupRequestSchema.updateOne({ requestId }, { $set: { status: "pending", decidedBy: null } });
      throw err;
    }
  }

  await setFinal(requestId, { status: approve ? "approved" : "declined", decidedAt: new Date().toISOString() });
  return { ok: true, request: { ...claimed, status: approve ? "approved" : "declined" }, newBalance };
}

// Undo an approved top-up (e.g. the receipt turned out to be fake): takes the amount back off the
// buyer's balance. The balance may go below zero if they already spent it — that blocks buying
// until it's paid back.
async function reverseTopup({ requestId, guildId, by }) {
  const claimed = await topupRequestSchema.findOneAndUpdate(
    { requestId, guildId, status: "approved" },
    { $set: { status: "reversing", reversedBy: by } },
    { new: true }
  );
  if (!claimed) return { ok: false, existing: await topupRequestSchema.findOne({ requestId }) };

  let newBalance;
  try {
    const updated = await userSchema.findOneAndUpdate(
      { guildId: claimed.guildId, userId: claimed.userId },
      { $inc: { userBalance: -claimed.amount }, $setOnInsert: { guildId: claimed.guildId, userId: claimed.userId } },
      { upsert: true, new: true }
    );
    newBalance = updated.userBalance;
  } catch (err) {
    await topupRequestSchema.updateOne({ requestId }, { $set: { status: "approved", reversedBy: null } });
    throw err;
  }
  await setFinal(requestId, { status: "reversed", reversedAt: new Date().toISOString() });
  return { ok: true, request: claimed, newBalance };
}

const setFinal = async (requestId, set) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await topupRequestSchema.updateOne({ requestId }, { $set: set });
      return;
    } catch (err) {
      if (attempt === 2) console.error(`Top-up ${requestId}: status ${set.status} couldn't be saved:`, err.message);
      else await new Promise((r) => setTimeout(r, 300));
    }
  }
};

// ---- Staff-channel messages -------------------------------------------------------

const ago = (ms) => {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ${min % 60} min ago`;
};

// One line on what the reader saw: "GCash · ₱500.00 · to your number ✔ · 12 min ago".
const readSummary = (read, readError) => {
  if (!read) return `❓ Couldn't read it${readError ? ` (${clip(readError, 80)})` : ""}`;
  if (!read.layout) return "❓ Not a receipt layout I know";
  const owner = String(config.gcash.number || "").replace(/\D/g, "").slice(-10);
  return [
    read.layout === "instapay" ? "🏦 InstaPay (bank)" : "💙 GCash",
    read.amount != null ? php(read.amount) : "amount ?",
    owner ? (read.numbers.includes(owner) ? "to your number ✔" : "**not to your number** ✘") : null,
    read.sentAt ? ago(read.sentAt) : "date ?",
    read.ref ? `Ref \`${read.ref}\`` : "Ref ?",
  ]
    .filter(Boolean)
    .join(" · ");
};

const STATUS_TEXT = {
  auto: "✅ Auto-approved",
  rejected: "⛔ Auto-declined",
  check: "⏳ Needs approval",
  ok: "⏳ Needs approval",
};

function staffEmbed({ guild, user, request, result, read, readError, receiptName, newBalance }) {
  const v = result.verdict;
  const embed = baseEmbed({ guild })
    .setColor(v === "auto" ? COLORS.success : v === "rejected" ? COLORS.error : GCASH_BLUE)
    .setAuthor({ name: user.username, iconURL: user.displayAvatarURL?.() || undefined })
    .setTitle(v === "auto" ? "✅ GCash top-up auto-approved" : v === "rejected" ? "⛔ GCash top-up auto-declined" : "🧾 GCash top-up: needs approval")
    .setDescription(
      v === "auto"
        ? "Every receipt check passed, so the balance was credited automatically. If the receipt looks fake, press **Undo**."
        : v === "rejected"
          ? "This receipt was already used, so nothing was credited."
          : "Check the receipt matches the amount, then approve or decline."
    )
    .addFields(
      { name: "👤 User", value: `<@${request.userId}>\n\`${request.userId}\``, inline: true },
      { name: "💵 Amount", value: bmoney(request.amount), inline: true },
      { name: "📌 Status", value: STATUS_TEXT[v], inline: true },
      { name: "🔢 GCash Ref No.", value: request.reference ? `\`${request.reference}\`` : "*not read: check the screenshot*", inline: true },
      { name: "🆔 Request", value: `\`${request.requestId}\``, inline: true }
    );
  if (newBalance != null) embed.addFields({ name: "👛 New balance", value: bmoney(newBalance), inline: true });
  embed.addFields({ name: "🤖 Receipt check", value: readSummary(read, readError) });
  if (result.reasons.length && v !== "auto") {
    embed.addFields({ name: v === "rejected" ? "⛔ Why it was declined" : "🤖 Why it needs you", value: clip(result.reasons.map((r) => `• ${r}`).join("\n"), 1024) });
  }
  if (receiptName) embed.setImage(`attachment://${receiptName}`);
  return embed;
}

const reviewButtons = (requestId) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`topup:approve:${requestId}`).setLabel("Approve").setStyle(ButtonStyle.Success).setEmoji("✅"),
    new ButtonBuilder().setCustomId(`topup:decline:${requestId}`).setLabel("Decline").setStyle(ButtonStyle.Danger).setEmoji("✖️")
  );

const undoButton = (requestId) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`topup:undo:${requestId}`).setLabel("Undo (take it back)").setStyle(ButtonStyle.Secondary).setEmoji("↩️")
  );

// ---- Submitting a receipt (/topup amount receipt) -----------------------------------

const downloadReceipt = async (attachment) => {
  if (attachment.size > MAX_RECEIPT_BYTES) return { error: "That image is too big (max 8 MB)." };
  let buf;
  try {
    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error("Receipt download failed:", err.message);
    return { error: "I couldn't download your receipt image. Please try uploading it again." };
  }
  const type = imageType(buf);
  if (!type) return { error: "Your receipt must be a real image (PNG, JPG, WEBP or GIF screenshot)." };
  if (buf.length > MAX_RECEIPT_BYTES) return { error: "That image is too big (max 8 MB)." };
  return { buf, name: `receipt.${type}` };
};

/**
 * Checks and records a receipt. Returns { verdict, reasons, request, newBalance } where verdict is
 *   auto     credited now          check/ok  posted for staff approval
 *   rejected receipt reused        error     { message } nothing saved
 * reviewChannel must be a sendable channel (the approval channel).
 */
async function submitTopup({ client, guild, user, amount, attachment, typedRef, cfg, reviewChannel }) {
  const got = await downloadReceipt(attachment);
  if (got.error) return { verdict: "error", message: got.error };

  // Read the receipt (slow part, done before taking the lock).
  let read = null;
  let readError = null;
  try {
    read = parseReceipt(await getReader().read(got.buf));
  } catch (err) {
    readError = err.message;
  }
  const imageHash = crypto.createHash("sha256").update(got.buf).digest("hex");
  const auto = autoSettings(cfg);

  // Judge + save atomically with respect to other submissions.
  const { request, result } = await exclusive(async () => {
    const refUse = {
      typed: await statusOf("reference", typedRef),
      read: read?.ref && read.ref !== typedRef ? await statusOf("reference", read.ref) : null,
    };
    const result = judge({
      amount: amount * 100,
      typedRef,
      read,
      readError,
      ownerNumber: config.gcash.number,
      now: Date.now(),
      maxAgeMs: auto.maxAgeMin * 60000,
      refUse,
      imageUse: await statusOf("imageHash", imageHash),
      auto: { on: auto.on, max: auto.max * 100 },
    });
    const rejected = result.verdict === "rejected";
    const request = {
      requestId: crypto.randomBytes(6).toString("hex"),
      guildId: guild.id,
      userId: user.id,
      amount,
      reference: typedRef || read?.ref || null,
      imageHash,
      status: rejected ? "declined" : "pending",
      decidedBy: rejected ? "auto" : null,
      decidedAt: rejected ? new Date().toISOString() : null,
      reason: rejected ? result.reasons[0] : null,
      checkVerdict: result.verdict,
      checkReasons: result.reasons,
      readLayout: read?.layout || null,
      readAmount: read?.amount ?? null,
      receiptName: got.name,
      createdAt: new Date().toISOString(),
    };
    await topupRequestSchema.create(request);
    return { request, result };
  });

  const file = () => new AttachmentBuilder(got.buf, { name: got.name });
  const staffPing = config.staffRoleIds.map((id) => `<@&${id}>`).join(" ");

  // ---- Auto-declined: tell staff (no buttons) -------------------------------------
  if (result.verdict === "rejected") {
    reviewChannel
      .send({ embeds: [staffEmbed({ guild, user, request, result, read, readError, receiptName: got.name })], files: [file()], allowedMentions: { parse: [] } })
      .catch((err) => console.error("Posting declined top-up failed:", err.message));
    logEvent(client, guild.id, {
      type: "topup",
      title: "Top-up Auto-declined",
      userId: user.id,
      fields: [{ name: "Amount", value: bmoney(amount), inline: true }, { name: "Why", value: clip(result.reasons[0], 1000) }],
    });
    return { verdict: "rejected", reasons: result.reasons, request };
  }

  // ---- Auto-approved: credit now, post with an Undo button --------------------------
  if (result.verdict === "auto") {
    let decided;
    try {
      decided = await decideTopup({ requestId: request.requestId, guildId: guild.id, approve: true, decidedBy: "auto" });
    } catch (err) {
      console.error("Auto-approve credit failed, sending to staff instead:", err.message);
      decided = { ok: false };
    }
    if (decided.ok) {
      reviewChannel
        .send({
          embeds: [staffEmbed({ guild, user, request, result, read, readError, receiptName: got.name, newBalance: decided.newBalance })],
          files: [file()],
          components: [undoButton(request.requestId)],
          allowedMentions: { parse: [] },
        })
        .catch((err) => console.error("Posting auto-approved top-up failed:", err.message));
      scheduleRefresh(client, guild.id, { store: false, leaderboard: true });
      logEvent(client, guild.id, {
        type: "topup",
        title: "Top-up Auto-approved",
        userId: user.id,
        fields: [
          { name: "Amount", value: bmoney(amount), inline: true },
          { name: "Request", value: `\`${request.requestId}\``, inline: true },
          ...(request.reference ? [{ name: "GCash Ref", value: `\`${request.reference}\``, inline: true }] : []),
          { name: "New balance", value: bmoney(decided.newBalance), inline: true },
        ],
      });
      return { verdict: "auto", reasons: [], request, newBalance: decided.newBalance };
    }
    // Credit failed: fall through to manual review so the buyer isn't stuck.
    result.verdict = "check";
    result.reasons = ["Auto-approve failed on my side, so please approve this one by hand."];
    await topupRequestSchema.updateOne({ requestId: request.requestId, status: "pending" }, { $set: { checkVerdict: "check", checkReasons: result.reasons } });
  }

  // ---- Needs a person ----------------------------------------------------------------
  try {
    await reviewChannel.send({
      content: staffPing || undefined,
      embeds: [staffEmbed({ guild, user, request, result, read, readError, receiptName: got.name })],
      files: [file()],
      components: [reviewButtons(request.requestId)],
      allowedMentions: { roles: config.staffRoleIds },
    });
  } catch (err) {
    console.error("Posting top-up review failed:", err.message);
    await topupRequestSchema.findOneAndDelete({ requestId: request.requestId, status: "pending" });
    return { verdict: "error", message: "Couldn't post your request for review. Please contact staff." };
  }
  return { verdict: result.verdict, reasons: result.reasons, request };
}

// Rewrites a staff message's embed after a decision (keeps the receipt image).
const restyle = (message, { color, status, extraFields = [] }) => {
  const embed = EmbedBuilder.from(message.embeds[0]).setColor(color);
  const fields = embed.data.fields || [];
  const i = fields.findIndex((f) => f.name.includes("Status"));
  const statusField = { name: "📌 Status", value: status, inline: true };
  if (i >= 0) embed.spliceFields(i, 1, statusField);
  else embed.addFields(statusField);
  for (const f of extraFields) {
    const j = (embed.data.fields || []).findIndex((x) => x.name === f.name);
    if (j >= 0) embed.spliceFields(j, 1, f);
    else embed.addFields(f);
  }
  const img = message.embeds[0]?.image?.url;
  if (img) {
    const name = img.split("?")[0].split("/").pop();
    if (name) embed.setImage(`attachment://${name}`);
  }
  return embed;
};

module.exports = {
  GCASH_BLUE,
  MAX_RECEIPT_BYTES,
  autoSettings,
  submitTopup,
  decideTopup,
  reverseTopup,
  restyle,
  readSummary,
};
