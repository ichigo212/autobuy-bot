const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const config = require("../config");

// ---------------------------------------------------------------------------
// Interactive /embed builder.
//
// A "draft" is the embed a staff member is currently composing, plus the target
// channel to post it to and any custom link buttons they've added. Drafts live
// only in memory, keyed by the builder's user id, and are cleared on Post/cancel
// (a bot restart drops in-progress drafts — acceptable, they're transient).
//
// The interaction router (events/interaction/interactionCreate.js) drives the
// lifecycle: /embed creates a draft and shows renderPreview(); the control
// buttons open modals; modal submits mutate the draft and re-render.
// ---------------------------------------------------------------------------

const drafts = new Map();

const getDraft = (userId) => drafts.get(userId);
// Drafts expire after an hour of inactivity so abandoned ones don't pile up.
const DRAFT_TTL_MS = 60 * 60 * 1000;
const setDraft = (userId, draft) => {
  clearTimeout(drafts.get(userId)?._timer);
  draft._timer = setTimeout(() => drafts.delete(userId), DRAFT_TTL_MS);
  draft._timer.unref?.();
  drafts.set(userId, draft);
};
const clearDraft = (userId) => drafts.delete(userId);

// Create a fresh, empty draft.
const newDraft = (channelId) => ({
  channelId, // where Post will send it
  title: "",
  description: "",
  author: "",
  color: config.color, // hex string
  imageUrl: "",
  thumbnailUrl: "",
  footer: "",
  links: [], // [{ label, url }]
});

// A hex string usable by EmbedBuilder.setColor. Falls back to the brand colour
// if the stored value is empty/invalid, so a preview never throws.
const safeColor = (value) => {
  const v = (value || "").trim();
  if (/^#?[0-9a-fA-F]{6}$/.test(v)) return v.startsWith("#") ? v : `#${v}`;
  return config.color;
};

// Build the EmbedBuilder from a draft. Discord rejects a completely empty embed,
// so while the draft has no content we show a placeholder description.
const buildEmbedFromDraft = (draft) => {
  const embed = new EmbedBuilder().setColor(safeColor(draft.color));

  if (draft.title) embed.setTitle(draft.title.slice(0, 256));
  if (draft.author) embed.setAuthor({ name: draft.author.slice(0, 256) });

  const hasContent = draft.title || draft.description || draft.imageUrl || draft.thumbnailUrl;
  embed.setDescription(
    draft.description
      ? draft.description.slice(0, 4096)
      : hasContent
      ? null
      : "_Empty embed — use the buttons below to add a title, description, and more._"
  );

  const isUrl = (u) => /^https?:\/\/\S+$/i.test(u || "");
  if (isUrl(draft.imageUrl)) embed.setImage(draft.imageUrl);
  if (isUrl(draft.thumbnailUrl)) embed.setThumbnail(draft.thumbnailUrl);
  if (draft.footer) embed.setFooter({ text: draft.footer.slice(0, 2048) });

  return embed;
};

// The link buttons for the FINAL posted message. Discord allows max 5 buttons
// per row and 5 rows; we cap at 5 links (one row) to keep it simple.
const buildLinkRows = (draft) => {
  const links = (draft.links || []).slice(0, 5);
  if (links.length === 0) return [];
  const row = new ActionRowBuilder();
  for (const l of links) {
    row.addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(l.label.slice(0, 80)).setURL(l.url)
    );
  }
  return [row];
};

// The builder controls shown ONLY to the composer (never posted).
const buildControlRows = (draft) => [
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("embed:content").setLabel("Content").setEmoji("📝").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("embed:appearance").setLabel("Appearance").setEmoji("🎨").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("embed:addlink").setLabel("Add link").setEmoji("🔗").setStyle(ButtonStyle.Secondary).setDisabled((draft.links || []).length >= 5),
    new ButtonBuilder().setCustomId("embed:clearlinks").setLabel("Clear links").setEmoji("🧹").setStyle(ButtonStyle.Secondary).setDisabled(!(draft.links || []).length)
  ),
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("embed:post").setLabel("Post").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("embed:cancel").setLabel("Cancel").setEmoji("✖️").setStyle(ButtonStyle.Danger)
  ),
];

// The ephemeral preview shown to the composer: the live embed, its link buttons,
// and the control row. Used both for the initial reply and every re-render.
const renderPreview = (draft) => {
  const components = [...buildLinkRows(draft), ...buildControlRows(draft)];
  return {
    content:
      "**Embed preview** — this is only visible to you. Link buttons appear above; use the controls below, then **Post**.",
    embeds: [buildEmbedFromDraft(draft)],
    components,
  };
};

module.exports = {
  getDraft,
  setDraft,
  clearDraft,
  newDraft,
  buildEmbedFromDraft,
  buildLinkRows,
  renderPreview,
  safeColor,
};
