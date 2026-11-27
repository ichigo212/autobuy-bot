const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const config = require("../config");
const { baseEmbed, error } = require("../utils/embeds");
const userSchema = require("../db/models/userSchema");

module.exports = {
  name: "balance",
  category: "Economy",
  description: "Check your balance",
  hidden: false,
  options: [
    {
      name: "user",
      description: "Check another user's balance (Discord user)",
      type: ApplicationCommandOptionType.User,
      required: false,
    },
  ],

  callback: async (client, interaction) => {
    const target = interaction.options.getUser("user") || interaction.user;
    const userData = await userSchema.findOne({ guildId: interaction.guild.id, userId: target.id });
    const balance = userData?.userBalance ?? 0;

    const embed = baseEmbed(interaction)
      .setColor("Green")
      .setAuthor({
        name: `Balance for ${target.username}`,
        iconURL: target.displayAvatarURL(),
      })
      .setDescription(`Balance: **${balance}** ${config.currency}`);

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
