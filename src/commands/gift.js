const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const { success, error } = require("../utils/embeds");
const { bmoney } = require("../utils/format");
const { logEvent } = require("../utils/logger");
const { scheduleRefresh } = require("../utils/liveEmbeds");
const userSchema = require("../db/models/userSchema");

module.exports = {
  name: "gift",
  category: "Economy",
  description: "Gift some of your balance to another user",
  hidden: false,
  options: [
    { name: "user", description: "Who to gift balance to", type: ApplicationCommandOptionType.User, required: true },
    { name: "amount", description: "How much to gift", type: ApplicationCommandOptionType.Integer, required: true, minValue: 1 },
    { name: "message", description: "A short note for them (optional)", type: ApplicationCommandOptionType.String, required: false, maxLength: 200 },
  ],

  callback: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = interaction.guild.id;
    const target = interaction.options.getUser("user");
    const amount = interaction.options.getInteger("amount");
    const note = interaction.options.getString("message");

    if (target.bot) return interaction.editReply({ embeds: [error(interaction, "You can't gift balance to a bot.")] });
    if (target.id === interaction.user.id) return interaction.editReply({ embeds: [error(interaction, "You can't gift balance to yourself.")] });

    // Atomic conditional debit from the sender (no double-spend).
    const sender = await userSchema.findOneAndUpdate(
      { guildId, userId: interaction.user.id, userBalance: { $gte: amount } },
      { $inc: { userBalance: -amount } },
      { new: true }
    );
    if (!sender) return interaction.editReply({ embeds: [error(interaction, `You don't have enough balance to gift ${bmoney(amount)}.`)] });

    let recipient;
    try {
      recipient = await userSchema.findOneAndUpdate(
        { guildId, userId: target.id },
        { $inc: { userBalance: amount }, $setOnInsert: { guildId, userId: target.id } },
        { upsert: true, new: true }
      );
    } catch (err) {
      // Give the sender their money back if the credit failed.
      await userSchema.updateOne({ guildId, userId: interaction.user.id }, { $inc: { userBalance: amount } });
      throw err;
    }

    scheduleRefresh(client, guildId, { store: false, leaderboard: true });
    logEvent(client, guildId, {
      type: "gift",
      title: "Balance Gifted",
      userId: interaction.user.id,
      fields: [
        { name: "From", value: `<@${interaction.user.id}>`, inline: true },
        { name: "To", value: `<@${target.id}>`, inline: true },
        { name: "Amount", value: bmoney(amount), inline: true },
      ],
    });

    target
      .send({
        embeds: [
          success(
            interaction,
            `You received ${bmoney(amount)} from **${interaction.user.username}** in **${interaction.guild.name}**!${note ? `\n> ${note}` : ""}\nNew balance: ${bmoney(recipient.userBalance)}.`
          ).setTitle("🎁 You got a gift!"),
        ],
      })
      .catch(() => {});

    return interaction.editReply({ embeds: [success(interaction, `Gifted ${bmoney(amount)} to ${target}. Your balance is now ${bmoney(sender.userBalance)}.`)] });
  },
};
