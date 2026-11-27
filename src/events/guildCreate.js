const { commandPayloads } = require("../utils/handler");

// Fired when the bot joins a new server: register commands there immediately.
module.exports = async (client, guild) => {
  try {
    await guild.commands.set(commandPayloads(client));
    console.log(`Deployed commands to new guild: ${guild.name}`);
  } catch (err) {
    console.error(`Failed to deploy commands to new guild ${guild.id}:`, err.message);
  }
};
