const { buildLeaderboardEmbed } = require("../utils/liveEmbeds");

module.exports = {
  name: "leaderboard",
  category: "Economy",
  description: "Show top 10 users with balance",
  hidden: false,

  callback: async (client, interaction) => {
    const embed = await buildLeaderboardEmbed(interaction.guild);
    return interaction.reply({ embeds: [embed] });
  },
};
