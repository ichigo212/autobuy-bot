const { ActivityType } = require("discord.js");
const Database = require("../db/connection");
const { commandPayloads } = require("../utils/handler");
const { startDailyReports } = require("../utils/dailyReport");
const { loadAdmins } = require("../utils/permissions");
const bus = require("../utils/bus");
const { notifyRestock } = require("../utils/features");

module.exports = async (client) => {
  console.log(`${client.user.username} is online.`);

  // The store, sales and coupons live in MongoDB — running without it would
  // half-work and confuse buyers, so stop instead.
  try {
    await new Database().connectToMongo(process.env.MONGODB_URI);
  } catch (err) {
    console.error("Cannot start without a database connection. Check MONGODB_URI (or use start.bat).", err.message);
    process.exit(1);
  }

  const admins = await loadAdmins().catch((err) => (console.error("Loading bot admins failed:", err.message), 0));
  if (admins) console.log(`Loaded bot admins for ${admins} server(s).`);

  startDailyReports(client);
  if (!bus.listenerCount("restock")) {
    bus.on("restock", (e) => notifyRestock(client, e).catch((err) => console.error("Restock alerts failed:", err.message)));
  }

  // Rotate presence every 5 minutes.
  let i = 0;
  const updateActivity = () => {
    const users = client.guilds.cache.reduce((a, g) => a + (g.memberCount || 0), 0);
    const activities = [
      { name: "/store • /help", type: ActivityType.Playing },
      { name: `${users.toLocaleString("en-US")} users`, type: ActivityType.Watching },
    ];
    client.user.setPresence({ status: "online", activities: [activities[i++ % activities.length]] });
  };
  updateActivity();
  setInterval(updateActivity, 5 * 60 * 1000).unref();

  // Register commands per guild (instant updates, no "command is outdated").
  const payloads = commandPayloads(client);
  try {
    const guilds = await client.guilds.fetch();
    for (const [guildId] of guilds) {
      try {
        const guild = await client.guilds.fetch(guildId);
        await guild.commands.set(payloads);
        console.log(`Deployed ${payloads.length} commands to ${guild.name}`);
      } catch (err) {
        console.error(`Failed to deploy commands to guild ${guildId}:`, err.message);
      }
    }
    // Clear stale GLOBAL commands so users don't see duplicates.
    await client.application.commands.set([]);
  } catch (err) {
    console.error("Command deployment failed:", err);
  }
};
