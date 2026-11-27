const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const crypto = require("crypto");
const { requireStaff } = require("../utils/permissions");
const { baseEmbed, success, error } = require("../utils/embeds");
const { bmoney, ts, clip } = require("../utils/format");
const { logEvent } = require("../utils/logger");
const expenseSchema = require("../db/models/expenseSchema");

// /expense — log one-off business costs (ads, bulk buys, fees). /analytics
// subtracts them from gross profit to show NET profit.
module.exports = {
  name: "expense",
  category: "Staff",
  description: "Log business expenses (ads, bulk stock, fees) so analytics shows real net profit",
  hidden: true,
  options: [
    {
      name: "add",
      description: "Log an expense",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        { name: "amount", description: "How much you spent", type: ApplicationCommandOptionType.Number, required: true, minValue: 0.01 },
        { name: "note", description: "What it was for (e.g. FB ads, 50 Nitro codes)", type: ApplicationCommandOptionType.String, required: true, maxLength: 150 },
      ],
    },
    { name: "list", description: "Show recent expenses and the total", type: ApplicationCommandOptionType.Subcommand },
    {
      name: "remove",
      description: "Delete an expense by its ID",
      type: ApplicationCommandOptionType.Subcommand,
      options: [{ name: "id", description: "The expense ID from /expense list", type: ApplicationCommandOptionType.String, required: true }],
    },
  ],

  callback: async (client, interaction) => {
    if (!(await requireStaff(interaction))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = interaction.guild.id;
    const sub = interaction.options.getSubcommand();

    if (sub === "add") {
      const amount = Math.round(interaction.options.getNumber("amount") * 100) / 100;
      const note = interaction.options.getString("note");
      const expenseId = crypto.randomBytes(3).toString("hex").toUpperCase();
      await expenseSchema.create({ guildId, expenseId, amount, note, createdBy: interaction.user.id });
      logEvent(client, guildId, { type: "admin", title: "Expense Logged", actorId: interaction.user.id, description: `${bmoney(amount)} — ${note} (\`${expenseId}\`)` });
      return interaction.editReply({ embeds: [success(interaction, `Logged ${bmoney(amount)} for **${note}** (ID \`${expenseId}\`). It's now subtracted from net profit in \`/analytics\`.`)] });
    }

    if (sub === "remove") {
      const id = interaction.options.getString("id").trim().toUpperCase();
      const removed = await expenseSchema.findOneAndDelete({ guildId, expenseId: id });
      if (!removed) return interaction.editReply({ embeds: [error(interaction, `No expense with ID \`${id}\`.`)] });
      logEvent(client, guildId, { type: "admin", title: "Expense Removed", actorId: interaction.user.id, description: `${bmoney(removed.amount)} — ${removed.note}` });
      return interaction.editReply({ embeds: [success(interaction, `Removed expense \`${id}\` (${bmoney(removed.amount)} — ${removed.note}).`)] });
    }

    const recent = await expenseSchema.find({ guildId }).sort({ createdAt: -1 }).limit(20).lean();
    const all = await expenseSchema.find({ guildId }, { amount: 1, createdAt: 1 }).lean();
    const since30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const total = all.reduce((a, e) => a + e.amount, 0);
    const total30 = all.filter((e) => new Date(e.createdAt).getTime() >= since30).reduce((a, e) => a + e.amount, 0);

    const embed = baseEmbed(interaction)
      .setTitle("💸 Expenses")
      .addFields({ name: "Last 30 days", value: bmoney(total30), inline: true }, { name: "All time", value: bmoney(total), inline: true });
    embed.setDescription(
      recent.length
        ? recent.map((e) => `\`${e.expenseId}\` ${bmoney(e.amount)} — ${clip(e.note, 60)} · ${ts(e.createdAt)}`).join("\n")
        : "No expenses logged yet. Add one with `/expense add`."
    );
    return interaction.editReply({ embeds: [embed] });
  },
};
