require("dotenv/config");

// Log stray async errors instead of crashing the whole bot.
process.on("unhandledRejection", (err) => console.error("Unhandled promise rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));

const { Client, Collection, GatewayIntentBits } = require("discord.js");
const { eventListener, loadSlashCommands } = require("./utils/handler");

if (!process.env.BOT_TOKEN) {
  console.error("BOT_TOKEN is missing. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const client = new Client({
  // Guilds: slash commands + guild/channel data.
  // GuildMessages: lets sticky messages re-post when someone chats (we only need
  // the event, not message content, so no privileged intent is required).
  // DirectMessages: DM channel events for delivery.
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages],
});

client.commands = new Collection();
loadSlashCommands(client);
eventListener(client);

client.login(process.env.BOT_TOKEN);

module.exports = client;
