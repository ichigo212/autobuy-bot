const { getSticky, scheduleRestick } = require("../utils/sticky");

// Keep sticky messages at the bottom of their channel. Cheap for every message:
// an in-memory lookup, then a debounced re-post only in sticky channels.
module.exports = async (client, message) => {
  if (message.author?.bot || !message.guild) return;
  try {
    const sticky = await getSticky(message.channel.id);
    if (!sticky?.content) return;
    scheduleRestick(client, message.channel);
  } catch (err) {
    console.error("Sticky check failed:", err.message);
  }
};
