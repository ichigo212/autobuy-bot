const config = require("../config");
const guildConfigSchema = require("../db/models/guildConfigSchema");
const { buildDailyReportEmbed, dayKey, keysBack } = require("./analytics");

// Nightly report: shortly after midnight (config.timezone), post yesterday's
// summary to the log channel of every server that turned it on with
// `/setlogchannel daily-report:true`. `lastDailyReport` prevents duplicates,
// and a report missed while the bot was off is posted when it comes back.

const hourNow = () => Number(new Intl.DateTimeFormat("en-US", { timeZone: config.timezone, hour: "numeric", hourCycle: "h23" }).format(new Date())) % 24;

const runDailyReports = async (client) => {
  const yesterday = keysBack(1, 1)[0];
  const due = await guildConfigSchema.find({ dailyReport: true, logChannelId: { $ne: null }, lastDailyReport: { $ne: yesterday } }).lean();
  for (const cfg of due) {
    try {
      const guild = await client.guilds.fetch(cfg.guildId).catch(() => null);
      const channel = guild && (await client.channels.fetch(cfg.logChannelId).catch(() => null));
      if (!channel?.isTextBased?.()) continue;
      // Claim the day first so two runs never double-post.
      const claimed = await guildConfigSchema.findOneAndUpdate(
        { guildId: cfg.guildId, lastDailyReport: { $ne: yesterday } },
        { $set: { lastDailyReport: yesterday } }
      );
      if (!claimed) continue;
      try {
        await channel.send({ embeds: [await buildDailyReportEmbed(guild)] });
      } catch (err) {
        // Give the day back so the next tick retries it.
        await guildConfigSchema.updateOne({ guildId: cfg.guildId }, { $set: { lastDailyReport: claimed.lastDailyReport ?? null } });
        throw err;
      }
    } catch (err) {
      console.error(`Daily report failed for ${cfg.guildId}:`, err.message);
    }
  }
};

const startDailyReports = (client) => {
  const tick = () => {
    // Wait until 00:05+ so "yesterday" is complete; any time after that works
    // (catches up if the bot was offline at midnight).
    if (hourNow() === 0 && new Date().getMinutes() < 5) return;
    runDailyReports(client).catch((err) => console.error("Daily reports:", err.message));
  };
  setTimeout(tick, 30 * 1000).unref();
  setInterval(tick, 10 * 60 * 1000).unref();
};

module.exports = { startDailyReports, runDailyReports, dayKey };
