const { ApplicationCommandOptionType, ChannelType, MessageFlags } = require("discord.js");
const { requireOwner } = require("../utils/permissions");
const { success, error } = require("../utils/embeds");
const guildConfigSchema = require("../db/models/guildConfigSchema");

module.exports = {
  name: "setlogchannel",
  category: "Admin",
  description: "(Admin) Set the channel where sale/refund/redeem logs are posted",
  hidden: true,
  options: [
    {
      name: "channel",
      description: "The channel to send logs to (leave empty to disable)",
      type: ApplicationCommandOptionType.Channel,
      channelTypes: [ChannelType.GuildText],
      required: false,
    },
    {
      name: "daily-report",
      description: "Post yesterday's sales & profit summary here every night (default: keep current)",
      type: ApplicationCommandOptionType.Boolean,
      required: false,
    },
  ],

  callback: async (client, interaction) => {
    if (!(await requireOwner(interaction))) return;

    const channel = interaction.options.getChannel("channel");
    const daily = interaction.options.getBoolean("daily-report");

    await guildConfigSchema.findOneAndUpdate(
      { guildId: interaction.guild.id },
      {
        $set: { logChannelId: channel ? channel.id : null, ...(daily != null ? { dailyReport: daily } : {}) },
        $setOnInsert: { guildId: interaction.guild.id },
      },
      { upsert: true }
    );

    return interaction.reply({
      embeds: [
        success(
          interaction,
          channel
            ? `Logs will now be posted to ${channel}.${daily === true ? " 📅 A daily sales report will be posted here every night." : daily === false ? " Daily report turned off." : ""}`
            : "Logging disabled."
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};
