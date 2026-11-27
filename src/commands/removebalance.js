const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const { requireOwner } = require("../utils/permissions");
const { success, error } = require("../utils/embeds");
const { bmoney } = require("../utils/format");
const { logEvent } = require("../utils/logger");
const { scheduleRefresh } = require("../utils/liveEmbeds");
const userSchema = require("../db/models/userSchema");

module.exports = {
  name: "removebalance",
  category: "Admin",
  description: "Admin: remove balance from a user",
  hidden: true,
  options: [
    { name: "user", description: "The Discord user to debit", type: ApplicationCommandOptionType.User, required: true },
    { name: "amount", description: "Amount to remove", type: ApplicationCommandOptionType.Integer, required: true, minValue: 1 },
    { name: "reason", description: "Why (shown in the staff log)", type: ApplicationCommandOptionType.String, required: false, maxLength: 200 },
  ],

  callback: async (client, interaction) => {
    if (!(await requireOwner(interaction))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const target = interaction.options.getUser("user");
    const amount = interaction.options.getInteger("amount");
    const reason = interaction.options.getString("reason");

    // One atomic update: subtract, then clamp at 0. The pre-image tells us how
    // much was actually removed.
    const before = await userSchema.findOneAndUpdate(
      { guildId: interaction.guild.id, userId: target.id },
      { $inc: { userBalance: -amount }, $max: { userBalance: 0 } },
      { new: false }
    );
    if (!before) return interaction.editReply({ embeds: [error(interaction, `${target} has no balance.`)] });

    const prev = Number(before.userBalance) || 0;
    const removed = Math.min(amount, prev);
    const now = prev - removed;

    scheduleRefresh(client, interaction.guild.id, { store: false, leaderboard: true });
    logEvent(client, interaction.guild.id, {
      type: "balance",
      title: "Balance Removed",
      userId: target.id,
      actorId: interaction.user.id,
      fields: [
        { name: "Amount", value: `−${bmoney(removed)}`, inline: true },
        { name: "New balance", value: bmoney(now), inline: true },
        ...(reason ? [{ name: "Reason", value: reason }] : []),
      ],
    });

    return interaction.editReply({ embeds: [success(interaction, `Removed ${bmoney(removed)} from ${target}. New balance: ${bmoney(now)}.`)] });
  },
};
