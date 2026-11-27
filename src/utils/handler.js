const fs = require("fs");
const path = require("path");

// Recursively list every .js file under a folder. Uses path.join so it works on
// Windows AND Linux hosts (the old version hard-coded "\\" and broke on Linux).
const getAllFiles = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...getAllFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
};

const baseName = (file) => path.basename(file, ".js");

const loadSlashCommands = (client) => {
  for (const file of getAllFiles(path.join(__dirname, "..", "commands"))) {
    const command = require(file);
    if (typeof command?.callback !== "function") {
      console.warn(`Skipping ${file}: no callback exported.`);
      continue;
    }
    client.commands.set(command.name || baseName(file), command);
  }
  console.log(`Loaded ${client.commands.size} (/) commands.`);
};

// Event files are named after the discord.js event they handle
// (e.g. events/interaction/interactionCreate.js → "interactionCreate").
const eventListener = (client) => {
  for (const file of getAllFiles(path.join(__dirname, "..", "events"))) {
    const handler = require(file);
    if (typeof handler !== "function") throw new Error(`Event file ${file} must export a function.`);
    client.on(baseName(file), (...args) =>
      Promise.resolve(handler(client, ...args)).catch((err) => console.error(`Error in ${baseName(file)}:`, err))
    );
  }
};

// The payload Discord receives for registration (internal fields stripped).
const commandPayloads = (client) =>
  [...client.commands.values()].map(({ name, description, options }) => ({ name, description, options: options || [] }));

module.exports = { loadSlashCommands, eventListener, getAllFiles, commandPayloads };
