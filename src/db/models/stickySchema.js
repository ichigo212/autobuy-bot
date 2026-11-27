// A sticky message: content the bot keeps re-posting at the bottom of a channel
// so it's always the most recent message. One sticky per channel.
//
// FILE-BASED (same store engine as balances) so stickies survive restarts and
// don't depend on MongoDB. Keyed by (guildId, channelId). lastMessageId tracks
// the bot's current sticky message so it can delete the old one when re-posting.
const { getCollection } = require("../fileStore");

module.exports = getCollection("sticky-messages");
