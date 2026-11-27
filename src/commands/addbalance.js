const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const { requireStaff } = require("../utils/permissions");
const { success, error } = require("../utils/embeds");
const { bmoney } = require("../utils/format");
const { logEvent } = require("../utils/logger");
const { scheduleRefresh } = require("../utils/liveEmbeds");
const userSchema = require("../db/models/userSchema");

module.exports = {
  name: "addbalance",
  category: "Staff",
  description: "Staff: add balance to a user",
  hidden: true,
  options: [
    { name: "user", description: "The Discord user to credit", type: ApplicationCommandOptionType.User, required: true },
    { name: "amount", description: "Amount to add", type: ApplicationCommandOptionType.Integer, required: true, minValue: 1, maxValue: 10000000 },
    { name: "reason", description: "Why (shown in the staff log)", type: ApplicationCommandOptionType.String, required: false, maxLength: 200 },
  ],

  callback: async (client, interaction) => {
    if (!(await requireStaff(interaction))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const target = interaction.options.getUser("user");
    const amount = interaction.options.getInteger("amount");
    const reason = interaction.options.getString("reason");
    if (target.bot) return interaction.editReply({ embeds: [error(interaction, "Bots can't hold a balance.")] });

    const updated = await userSchema.findOneAndUpdate(
      { guildId: interaction.guild.id, userId: target.id },
      { $inc: { userBalance: amount }, $setOnInsert: { guildId: interaction.guild.id, userId: target.id } },
      { upsert: true, new: true }
    );

    scheduleRefresh(client, interaction.guild.id, { store: false, leaderboard: true });
    logEvent(client, interaction.guild.id, {
      type: "balance",
      title: "Balance Added",
      userId: target.id,
      actorId: interaction.user.id,
      fields: [
        { name: "Amount", value: `+${bmoney(amount)}`, inline: true },
        { name: "New balance", value: bmoney(updated.userBalance), inline: true },
        ...(reason ? [{ name: "Reason", value: reason }] : []),
      ],
    });

    return interaction.editReply({ embeds: [success(interaction, `Added ${bmoney(amount)} to ${target}. New balance: ${bmoney(updated.userBalance)}.`)] });
  },
};
