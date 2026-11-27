const { ApplicationCommandOptionType, ChannelType, MessageFlags } = require("discord.js");
const { requireOwner } = require("../utils/permissions");
const { success } = require("../utils/embeds");
const guildConfigSchema = require("../db/models/guildConfigSchema");

// /settopupchannel [channel] — set where GCash top-up requests are posted for
// staff review. Leave empty to clear (falls back to the log channel, then the
// channel the command is used in).
module.exports = {
  name: "settopupchannel",
  category: "Admin",
  description: "(Admin) Set the channel where GCash top-up requests are posted for review",
  hidden: true,
  options: [
    {
      name: "channel",
      description: "The channel for top-up review (leave empty to clear)",
      type: ApplicationCommandOptionType.Channel,
      channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
      required: false,
    },
  ],

  callback: async (client, interaction) => {
    if (!(await requireOwner(interaction))) return;

    const channel = interaction.options.getChannel("channel");

    await guildConfigSchema.findOneAndUpdate(
      { guildId: interaction.guild.id },
      {
        $set: { topupChannelId: channel ? channel.id : null },
        $setOnInsert: { guildId: interaction.guild.id },
      },
      { upsert: true }
    );

    return interaction.reply({
      embeds: [
        success(
          interaction,
          channel
            ? `GCash top-up requests will now be posted to ${channel}.`
            : "Top-up review channel cleared. Requests will go to the log channel (if set); otherwise /topup is disabled."
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};
