const { EmbedBuilder } = require("discord.js");
const config = require("../config");
const guildConfigSchema = require("../db/models/guildConfigSchema");

// Colour + emoji per event type for quick scanning in the staff log channel.
const EVENT_STYLE = {
  sale: { color: "#57F287", emoji: "🛒" },
  refund: { color: "#ED4245", emoji: "↩️" },
  redeem: { color: "#5865F2", emoji: "🎟️" },
  gift: { color: "#FEE75C", emoji: "🎁" },
  balance: { color: "#EB459E", emoji: "💰" },
  topup: { color: "#3BA55D", emoji: "🧾" },
  stock: { color: "#F0B232", emoji: "📦" },
  admin: { color: "#99AAB5", emoji: "🛠️" },
};

// Posts an event embed to the guild's configured log channel (if any).
// Best-effort: never throws, so it can't break the action being logged.
//
// event: { type, title, fields: [{name, value, inline}], userId?, actorId?, thumbnail?, description? }
const logEvent = async (client, guildId, event) => {
  try {
    const cfg = await guildConfigSchema.findOne({ guildId });
    if (!cfg?.logChannelId) return;

    const channel = await client.channels.fetch(cfg.logChannelId).catch(() => null);
    if (!channel?.isTextBased?.()) return;

    const style = EVENT_STYLE[event.type] || { color: config.color, emoji: "📋" };
    const embed = new EmbedBuilder()
      .setColor(style.color)
      .setTitle(`${style.emoji} ${event.title}`)
      .addFields((event.fields || []).slice(0, 25))
      .setFooter({ text: `${config.brand} • ${event.type || "log"}` })
      .setTimestamp();

    const lines = [];
    if (event.userId) lines.push(`**User:** <@${event.userId}> (\`${event.userId}\`)`);
    if (event.actorId && event.actorId !== event.userId) lines.push(`**By:** <@${event.actorId}>`);
    if (event.description) lines.push(event.description);
    if (lines.length) embed.setDescription(lines.join("\n"));

    if (event.userId) {
      const user = await client.users.fetch(event.userId).catch(() => null);
      if (user) embed.setAuthor({ name: user.username, iconURL: user.displayAvatarURL() });
    }
    if (event.thumbnail) embed.setThumbnail(event.thumbnail);

    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    console.error("Failed to post log event:", err.message);
  }
};

module.exports = { logEvent };
