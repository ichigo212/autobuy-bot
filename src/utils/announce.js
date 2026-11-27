const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  LabelBuilder,
  FileUploadBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  MessageFlags,
} = require("discord.js");
const config = require("../config");
const { COLORS } = require("./embeds");
const { clip } = require("./format");
const { logEvent } = require("./logger");
const { isOwner } = require("./permissions");
const muteSchema = require("../db/models/announceMuteSchema");

// ---------------------------------------------------------------------------
// /announcement — write an announcement in a form (with a picture), preview
// it, then post it in a channel and/or DM every member of the server.
//
// Flow:  /announcement send  →  form  →  private preview [Send][Edit][Cancel]
//        → Send → live progress [Stop] → final report (also DMed to sender).
// DMs go out one at a time (DM_DELAY_MS apart) so Discord doesn't treat the
// bot as a spammer; every DM carries a "Mute announcements" button.
// ---------------------------------------------------------------------------

const EPHEMERAL = MessageFlags.Ephemeral;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const DRAFT_TTL_MS = 60 * 60 * 1000;
const PROGRESS_EVERY = 10; // edit the progress message every N DMs

const settings = { dmDelayMs: 1100, retryDelayMs: 30_000 }; // tests shorten these
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const drafts = new Map(); // `${guildId}:${userId}` -> draft
const jobs = new Map(); // guildId -> running broadcast
const draftKey = (guildId, userId) => `${guildId}:${userId}`;

const getDraft = (guildId, userId) => {
  const d = drafts.get(draftKey(guildId, userId));
  if (!d) return null;
  if (Date.now() - d.updatedAt > DRAFT_TTL_MS) {
    drafts.delete(draftKey(guildId, userId));
    return null;
  }
  return d;
};

// Start (or restart) a draft with the options picked in /announcement send.
// Text and picture from an unfinished earlier draft are kept so nothing is lost.
const startDraft = ({ guildId, userId, target, channelId, ping }) => {
  const prev = getDraft(guildId, userId);
  const draft = {
    guildId,
    userId,
    target,
    channelId,
    ping: ping || "none",
    title: prev?.title || "",
    message: prev?.message || "",
    buttonRaw: prev?.buttonRaw || "",
    button: prev?.button || null,
    image: prev?.image || null,
    updatedAt: Date.now(),
  };
  drafts.set(draftKey(guildId, userId), draft);
  return draft;
};

// ---- The form ----------------------------------------------------------------

const buildForm = (draft) => {
  const title = new TextInputBuilder()
    .setCustomId("title")
    .setStyle(TextInputStyle.Short)
    .setMaxLength(256)
    .setRequired(false)
    .setPlaceholder("e.g. 🎉 Big restock tonight at 8PM!");
  if (draft?.title) title.setValue(draft.title);

  const message = new TextInputBuilder()
    .setCustomId("message")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(4000)
    .setRequired(true)
    .setPlaceholder("Write your announcement here. **bold**, *italic*, links and emojis all work.");
  if (draft?.message) message.setValue(draft.message);

  const picture = new FileUploadBuilder().setCustomId("picture").setRequired(false).setMaxValues(1);

  const button = new TextInputBuilder()
    .setCustomId("button")
    .setStyle(TextInputStyle.Short)
    .setMaxLength(600)
    .setRequired(false)
    .setPlaceholder("Shop now | https://discord.com/channels/...");
  if (draft?.buttonRaw) button.setValue(draft.buttonRaw);

  return new ModalBuilder()
    .setCustomId("ann:form")
    .setTitle("📢 New Announcement")
    .addLabelComponents(
      new LabelBuilder().setLabel("Title").setDescription("Optional headline at the top").setTextInputComponent(title),
      new LabelBuilder().setLabel("Message").setDescription("What do you want to tell everyone?").setTextInputComponent(message),
      new LabelBuilder()
        .setLabel("Picture")
        .setDescription(draft?.image ? "Leave empty to keep the current picture" : "Optional: PNG, JPG, GIF or WEBP, max 8 MB")
        .setFileUploadComponent(picture),
      new LabelBuilder().setLabel("Link button").setDescription("Optional. Format: Button text | https://link").setTextInputComponent(button)
    );
};

// "Shop now | https://x" → { label, url }. Returns { error } when malformed.
const parseButton = (raw) => {
  const text = String(raw || "").trim();
  if (!text) return { button: null };
  const bar = text.indexOf("|");
  if (bar === -1) return { error: "The link button must look like `Button text | https://link`." };
  const label = text.slice(0, bar).trim();
  const url = text.slice(bar + 1).trim();
  if (!label) return { error: "The link button needs some text before the `|`." };
  if (!/^https?:\/\/\S+$/i.test(url)) return { error: "The link button's link must start with `https://`." };
  return { button: { label: clip(label, 80), url } };
};

const downloadImage = async (attachment) => {
  const type = String(attachment.contentType || "").split(";")[0].toLowerCase();
  const ext = IMAGE_EXT[type] || (/\.(png|jpe?g|gif|webp)$/i.exec(attachment.name || "")?.[1] || "").toLowerCase().replace("jpeg", "jpg");
  if (!ext) return { error: "The picture must be a PNG, JPG, GIF or WEBP image." };
  if (attachment.size > MAX_IMAGE_BYTES) return { error: "The picture is too big (max 8 MB)." };
  const res = await fetch(attachment.url);
  if (!res.ok) return { error: "Couldn't download the picture. Please try uploading it again." };
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) return { error: "The picture is too big (max 8 MB)." };
  return { image: { buffer, name: `announcement.${ext}` } };
};

// ---- What gets sent ----------------------------------------------------------

const buildAnnouncement = (guild, draft, { forDm = false } = {}) => {
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setAuthor({ name: clip(`📢 ${guild.name}`, 256), iconURL: guild.iconURL?.() || undefined })
    .setDescription(draft.message)
    .setFooter({ text: forDm ? `You're getting this because you're in ${clip(guild.name, 100)}` : config.brand })
    .setTimestamp();
  if (draft.title) embed.setTitle(draft.title);

  const files = [];
  if (draft.image) {
    embed.setImage(`attachment://${draft.image.name}`);
    files.push(new AttachmentBuilder(draft.image.buffer, { name: draft.image.name }));
  }

  const buttons = [];
  if (draft.button) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(draft.button.label).setURL(draft.button.url));
  if (forDm) {
    buttons.push(new ButtonBuilder().setCustomId(`ann:mute:${guild.id}`).setStyle(ButtonStyle.Secondary).setEmoji("🔕").setLabel("Mute announcements"));
  }

  const ping = !forDm && draft.ping !== "none" ? `@${draft.ping}` : undefined;
  return {
    content: ping,
    embeds: [embed],
    files,
    components: buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [],
    allowedMentions: ping ? { parse: ["everyone"] } : { parse: [] },
  };
};

const targetText = (draft, guild, mutedCount = 0) => {
  const lines = [];
  if (draft.target !== "dm") lines.push(`📍 **Posts in:** <#${draft.channelId}>${draft.ping !== "none" ? ` with @${draft.ping}` : ""}`);
  if (draft.target !== "channel") {
    const approx = Math.max(0, (guild.memberCount || 0) - mutedCount);
    lines.push(`📨 **DMs:** about **${approx.toLocaleString("en-US")}** members (bots and members who muted announcements are skipped)`);
  }
  return lines.join("\n");
};

const buildPreview = async (guild, draft) => {
  const muted = draft.target === "channel" ? 0 : await muteSchema.countDocuments({ guildId: guild.id });
  const payload = buildAnnouncement(guild, draft);
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("ann:send").setStyle(ButtonStyle.Success).setEmoji("✅").setLabel("Send"),
    new ButtonBuilder().setCustomId("ann:edit").setStyle(ButtonStyle.Primary).setEmoji("✏️").setLabel("Edit"),
    new ButtonBuilder().setCustomId("ann:cancel").setStyle(ButtonStyle.Danger).setEmoji("✖️").setLabel("Cancel")
  );
  return {
    content: [
      "👀 **Preview.** Only you can see this. Check it, then press **Send**.",
      targetText(draft, guild, muted),
      draft.target !== "channel" ? "-# DMs also get a 🔕 Mute announcements button." : null,
    ]
      .filter(Boolean)
      .join("\n"),
    embeds: payload.embeds,
    files: payload.files,
    attachments: [],
    components: [...payload.components, controls],
    allowedMentions: { parse: [] },
  };
};

// ---- Interaction handlers -----------------------------------------------------

const notAllowed = (i) =>
  i.reply({ content: "Only bot owners and admins can send announcements.", flags: EPHEMERAL }).catch(() => {});
const expired = (i) =>
  i.reply({ content: "⌛ This announcement draft expired (or the bot restarted). Run `/announcement send` again.", flags: EPHEMERAL }).catch(() => {});

const openForm = async (interaction, draft) => interaction.showModal(buildForm(draft));

const handleFormSubmit = async (client, i) => {
  if (!isOwner(i)) return notAllowed(i);
  const draft = getDraft(i.guildId, i.user.id);
  if (!draft) return expired(i);

  const message = i.fields.getTextInputValue("message").trim();
  const title = i.fields.getTextInputValue("title").trim();
  const buttonRaw = i.fields.getTextInputValue("button").trim();
  if (!message) return i.reply({ content: "The message can't be empty.", flags: EPHEMERAL });

  // Save the text first so "Edit" brings it back even if something below fails.
  Object.assign(draft, { title, message, buttonRaw, updatedAt: Date.now() });

  const parsed = parseButton(buttonRaw);
  if (parsed.error) return i.reply({ content: `❌ ${parsed.error}\nRun \`/announcement send\` again; your text was kept.`, flags: EPHEMERAL });
  draft.button = parsed.button;

  // Editing from the preview updates that preview; a fresh form gets a new reply.
  if (i.isFromMessage?.()) await i.deferUpdate();
  else await i.deferReply({ flags: EPHEMERAL });

  let files = null;
  try {
    files = i.fields.getUploadedFiles("picture");
  } catch {
    files = null;
  }
  if (files?.size) {
    const got = await downloadImage(files.first()).catch(() => ({ error: "Couldn't download the picture. Please try again." }));
    if (got.error) return i.editReply({ content: `❌ ${got.error}\nRun \`/announcement send\` again; your text was kept.`, embeds: [], components: [], attachments: [] });
    draft.image = got.image;
  }

  return i.editReply(await buildPreview(i.guild, draft));
};

const handleEdit = async (client, i) => {
  if (!isOwner(i)) return notAllowed(i);
  const draft = getDraft(i.guildId, i.user.id);
  if (!draft) return expired(i);
  return openForm(i, draft);
};

const handleCancel = async (client, i) => {
  drafts.delete(draftKey(i.guildId, i.user.id));
  return i.update({ content: "✖️ Announcement cancelled. Nothing was sent.", embeds: [], components: [], attachments: [] });
};

// Every member of the server except bots. Needs "Server Members Intent".
const fetchMemberIds = async (guild) => {
  const ids = [];
  let after = "0";
  for (;;) {
    const batch = await guild.members.list({ limit: 1000, after, cache: false });
    for (const m of batch.values()) if (!m.user?.bot) ids.push(m.id);
    if (batch.size < 1000) break;
    after = [...batch.keys()].reduce((a, b) => (BigInt(b) > BigInt(a) ? b : a), after);
  }
  return ids;
};

const MEMBERS_INTENT_HELP =
  "❌ I can't see the member list, so I can't DM everyone.\n" +
  "**Fix:** go to <https://discord.com/developers/applications> → your bot → **Bot** → turn ON **Server Members Intent** → Save. Then try again (no restart needed).";

const bar = (done, total) => {
  const n = total ? Math.round((done / total) * 12) : 12;
  return `${"▰".repeat(n)}${"▱".repeat(12 - n)} ${total ? Math.floor((done / total) * 100) : 100}%`;
};

const progressEmbed = (job) => {
  const finished = job.state !== "running";
  const embed = new EmbedBuilder()
    .setColor(job.state === "stopped" ? COLORS.warning : finished ? COLORS.success : COLORS.info)
    .setTitle(job.state === "running" ? "📤 Sending announcement…" : job.state === "stopped" ? "⏹️ Announcement stopped" : "✅ Announcement sent")
    .setTimestamp();
  const lines = [];
  if (job.channel) lines.push(`📍 **Channel:** ${job.channel.ok ? `posted in <#${job.channel.id}>${job.channel.url ? ` · [view](${job.channel.url})` : ""}` : `❌ ${job.channel.error}`}`);
  if (job.dm) {
    if (job.dm.error) lines.push(`📨 **DMs:** ${job.dm.error}`);
    else {
      const done = job.dm.sent + job.dm.closed + job.dm.failed;
      lines.push(
        `📨 **DMs:** ${done.toLocaleString("en-US")} / ${job.dm.total.toLocaleString("en-US")}`,
        bar(done, job.dm.total),
        `✅ ${job.dm.sent} delivered · 🔒 ${job.dm.closed} have DMs closed · ⚠️ ${job.dm.failed} failed${job.dm.muted ? ` · 🔕 ${job.dm.muted} muted (skipped)` : ""}`
      );
      if (job.state === "running") {
        const left = Math.ceil(((job.dm.total - done) * settings.dmDelayMs) / 60000);
        lines.push(`-# ⏱️ About ${left} min left. You can close this; I'll DM you the final report.`);
      }
    }
  }
  return embed.setDescription(lines.join("\n") || "Working…");
};

const progressPayload = (job) => ({
  content: "",
  embeds: [progressEmbed(job)],
  attachments: [],
  components:
    job.state === "running" && job.dm && !job.dm.error
      ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("ann:stop").setStyle(ButtonStyle.Danger).setEmoji("⏹️").setLabel("Stop sending"))]
      : [],
});

// Edits the progress message; the interaction token dies after 15 minutes,
// so failures are ignored (the final report is DMed to the sender anyway).
const pushProgress = async (job) => {
  try {
    await job.interaction.editReply(progressPayload(job));
  } catch {
    /* token expired or message dismissed */
  }
};

const sendDm = async (client, userId, payloadFn) => {
  const user = await client.users.fetch(userId);
  return user.send(payloadFn());
};

const runBroadcast = async (client, guild, draft, job) => {
  // 1) Channel post
  if (draft.target !== "dm") {
    job.channel = { id: draft.channelId, ok: false };
    try {
      const channel = await client.channels.fetch(draft.channelId);
      const msg = await channel.send(buildAnnouncement(guild, draft));
      job.channel.ok = true;
      job.channel.url = msg.url;
    } catch (err) {
      job.channel.error = err?.code === 50013 || err?.code === 50001 ? "I'm missing permission to post there." : `Couldn't post: ${clip(err?.message || "unknown error", 120)}`;
    }
    await pushProgress(job);
  }

  // 2) DM every member
  if (draft.target !== "channel") {
    job.dm = { total: 0, sent: 0, closed: 0, failed: 0, muted: 0 };
    let ids;
    try {
      ids = await fetchMemberIds(guild);
    } catch (err) {
      job.dm.error = err?.code === 50001 || err?.status === 403 ? MEMBERS_INTENT_HELP : `❌ Couldn't load the member list: ${clip(err?.message || "unknown error", 120)}`;
    }
    if (ids) {
      const muted = new Set(await muteSchema.distinct("userId", { guildId: guild.id }));
      const targets = ids.filter((id) => !muted.has(id));
      job.dm.muted = ids.length - targets.length;
      job.dm.total = targets.length;
      await pushProgress(job);

      for (let n = 0; n < targets.length; n++) {
        if (job.stopRequested) break;
        const payloadFn = () => buildAnnouncement(guild, draft, { forDm: true });
        try {
          await sendDm(client, targets[n], payloadFn);
          job.dm.sent++;
        } catch (err) {
          if (err?.code === 50007) job.dm.closed++;
          else if (err?.code === 40003 || err?.status === 429) {
            // Discord says we're opening DMs too fast: back off once, then retry.
            await sleep(settings.retryDelayMs);
            try {
              await sendDm(client, targets[n], payloadFn);
              job.dm.sent++;
            } catch (err2) {
              if (err2?.code === 50007) job.dm.closed++;
              else job.dm.failed++;
            }
          } else job.dm.failed++;
        }
        if ((n + 1) % PROGRESS_EVERY === 0) await pushProgress(job);
        if (n < targets.length - 1 && !job.stopRequested) await sleep(settings.dmDelayMs);
      }
    }
  }

  job.state = job.stopRequested ? "stopped" : "done";
  await pushProgress(job);
};

const handleSend = async (client, i) => {
  if (!isOwner(i)) return notAllowed(i);
  const draft = getDraft(i.guildId, i.user.id);
  if (!draft) return expired(i);
  if (jobs.has(i.guildId)) {
    return i.reply({ content: "⏳ Another announcement is still being sent in this server. Wait for it to finish (or stop it) first.", flags: EPHEMERAL });
  }

  // Claim the slot and consume the draft before any await, so a double-click
  // can never send the announcement twice.
  const job = { state: "running", stopRequested: false, interaction: i, startedBy: i.user.id, startedAt: Date.now() };
  jobs.set(i.guildId, job);
  drafts.delete(draftKey(i.guildId, i.user.id));

  try {
    await i.update(progressPayload(job));
    await runBroadcast(client, i.guild, draft, job);
  } catch (err) {
    console.error("Announcement broadcast failed:", err);
    job.state = job.stopRequested ? "stopped" : "done";
    job.crashed = err?.message || "unknown error";
  } finally {
    jobs.delete(i.guildId);
  }

  // Final report: DM to the sender (the progress message may have expired) + log channel.
  const report = progressEmbed(job);
  if (job.crashed) report.addFields({ name: "⚠️ Stopped early", value: clip(job.crashed, 1000) });
  report.setFooter({ text: `${i.guild.name} • /announcement` });
  i.user.send({ embeds: [report] }).catch(() => {});

  const fields = [];
  if (job.channel) fields.push({ name: "Channel", value: job.channel.ok ? `<#${job.channel.id}>` : `❌ ${job.channel.error}`, inline: true });
  if (job.dm && !job.dm.error) fields.push({ name: "DMs", value: `✅ ${job.dm.sent} · 🔒 ${job.dm.closed} · ⚠️ ${job.dm.failed} of ${job.dm.total}`, inline: true });
  logEvent(client, i.guildId, {
    type: "admin",
    title: job.state === "stopped" ? "Announcement stopped" : "Announcement sent",
    actorId: i.user.id,
    description: draft.title ? `**${clip(draft.title, 200)}**` : clip(draft.message, 200),
    fields,
  });
};

const handleStop = async (client, i) => {
  if (!isOwner(i)) return notAllowed(i);
  const job = jobs.get(i.guildId);
  if (!job || job.state !== "running") {
    return i.update({ components: [] }).catch(() => {});
  }
  job.stopRequested = true;
  job.interaction = i; // fresh token: keeps the progress message editable
  await i.deferUpdate().catch(() => {});
};

// "🔕 Mute announcements" in a DM — toggles.
const handleMuteToggle = async (client, i, guildId) => {
  const guildName = client.guilds.cache.get(guildId)?.name || "that server";
  const removed = await muteSchema.findOneAndDelete({ guildId, userId: i.user.id });
  if (removed) {
    return i.reply({ content: `🔔 Announcements from **${guildName}** are back on.`, flags: EPHEMERAL });
  }
  await muteSchema.updateOne({ guildId, userId: i.user.id }, { $setOnInsert: { guildId, userId: i.user.id } }, { upsert: true });
  return i.reply({ content: `🔕 Done. You won't get announcement DMs from **${guildName}** anymore. Press the button again to turn them back on.`, flags: EPHEMERAL });
};

const isBroadcasting = (guildId) => jobs.has(guildId);

module.exports = {
  settings,
  startDraft,
  getDraft,
  openForm,
  buildForm,
  parseButton,
  buildAnnouncement,
  buildPreview,
  fetchMemberIds,
  isBroadcasting,
  handleFormSubmit,
  handleEdit,
  handleCancel,
  handleSend,
  handleStop,
  handleMuteToggle,
};
