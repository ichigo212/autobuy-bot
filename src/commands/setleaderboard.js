const { MessageFlags } = require("discord.js");
const { requireOwner } = require("../utils/permissions");
const { buildLeaderboardEmbed } = require("../utils/liveEmbeds");
const guildConfigSchema = require("../db/models/guildConfigSchema");

module.exports = {
  name: "setleaderboard",
  category: "Admin",
  description: "(Admin) Create or set the live leaderboard message in this channel",
  hidden: true,

  callback: async (client, interaction) => {
    if (!(await requireOwner(interaction))) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const embed = await buildLeaderboardEmbed(interaction.guild);
    const message = await interaction.channel.send({ embeds: [embed] });

    await guildConfigSchema.findOneAndUpdate(
      { guildId: interaction.guild.id },
      {
        $set: {
          leaderboardChannelId: interaction.channel.id,
          leaderboardMessageId: message.id,
        },
        $setOnInsert: { guildId: interaction.guild.id },
      },
      { upsert: true }
    );

    return interaction.followUp({
      content: "✅ Live leaderboard set. It will refresh automatically when balances change.",
      flags: MessageFlags.Ephemeral,
    });
  },
};
