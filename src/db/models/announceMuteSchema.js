const { Schema, model, models } = require("mongoose");

// Members who pressed "🔕 Mute announcements" in an announcement DM.
// They are skipped by future /announcement DM broadcasts for that server.
const announceMuteSchema = new Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  mutedAt: { type: Date, default: Date.now },
});
announceMuteSchema.index({ guildId: 1, userId: 1 }, { unique: true });

const name = "announce-mute";
module.exports = models[name] || model(name, announceMuteSchema);
