const { EmbedBuilder } = require("discord.js");
const config = require("../config");
const stickySchema = require("../db/models/stickySchema");

// Sticky messages: content the bot keeps re-posting at the bottom of a channel.
//
// Two protections so a busy channel doesn't hammer the disk or Discord:
//   1. An in-memory cache of which channels have a sticky (refreshed whenever a
//      sticky is set/removed), so ordinary messages don't read the JSON file.
//   2. A per-channel debounce: a burst of messages causes ONE re-post a few
//      seconds after the chat goes quiet, instead of a delete+send per message.

const RESTICK_DELAY_MS = 4000;

let cache = null; // Map<channelId, sticky>
const loadCache = async () => {
  if (!cache) {
    const all = await stickySchema.find({});
    cache = new Map(all.map((s) => [s.channelId, s]));
  }
  return cache;
};
const invalidateStickyCache = () => {
  cache = null;
};
const getSticky = async (channelId) => (await loadCache()).get(channelId) || null;

const buildStickyEmbed = (content) =>
  new EmbedBuilder()
    .setColor(config.color)
    .setAuthor({ name: "📌 Pinned message" })
    .setDescription(String(content).slice(0, 4096))
    .setFooter({ text: config.brand });

// Serialised per channel so two re-posts never overlap (no duplicate stickies).
const chains = new Map();
const restick = (client, channel, sticky) => {
  const key = channel.id;
  const run = (chains.get(key) || Promise.resolve()).then(async () => {
    const current = (await stickySchema.findOne({ guildId: channel.guild.id, channelId: channel.id })) || sticky;
    if (!current?.content) return null;
    if (current.lastMessageId) {
      await channel.messages
        .fetch(current.lastMessageId)
        .then((m) => m.delete())
        .catch(() => {});
    }
    const sent = await channel.send({ embeds: [buildStickyEmbed(current.content)], allowedMentions: { parse: [] } });
    await stickySchema.findOneAndUpdate({ guildId: channel.guild.id, channelId: channel.id }, { $set: { lastMessageId: sent.id } });
    invalidateStickyCache();
    return sent.id;
  });
  chains.set(key, run.then(() => {}, () => {}));
  return run;
};

// Debounced re-stick, called from messageCreate.
const timers = new Map();
const scheduleRestick = (client, channel) => {
  clearTimeout(timers.get(channel.id));
  timers.set(
    channel.id,
    setTimeout(() => {
      timers.delete(channel.id);
      restick(client, channel).catch((err) => console.error("Sticky re-post failed:", err.message));
    }, RESTICK_DELAY_MS)
  );
};

module.exports = { restick, scheduleRestick, getSticky, invalidateStickyCache, buildStickyEmbed };
