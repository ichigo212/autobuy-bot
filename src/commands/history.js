const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const config = require("../config");
const { baseEmbed } = require("../utils/embeds");
const { isStaff } = require("../utils/permissions");
const saleSchema = require("../db/models/saleSchema");

module.exports = {
  name: "history",
  category: "Economy",
  description: "View purchase history (yours, or anyone's if you're staff)",
  hidden: false,
  options: [
    {
      name: "user",
      description: "Whose history to view (staff only; defaults to you)",
      type: ApplicationCommandOptionType.User,
      required: false,
    },
  ],

  callback: async (client, interaction) => {
    const requested = interaction.options.getUser("user");

    // Only staff may look up someone else's history.
    let target = interaction.user;
    if (requested && requested.id !== interaction.user.id) {
      if (!isStaff(interaction)) {
        return interaction.reply({
          content: "You can only view your own purchase history.",
          flags: MessageFlags.Ephemeral,
        });
      }
      target = requested;
    }

    const sales = await saleSchema
      .find({ guildId: interaction.guild.id, userId: target.id })
      .sort({ createdAt: -1 })
      .limit(15)
      .lean();

    const embed = baseEmbed(interaction)
      .setTitle("📜 Purchase History")
      .setAuthor({
        name: target.username,
        iconURL: target.displayAvatarURL(),
      });

    if (sales.length === 0) {
      embed.setDescription("No purchases found.");
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    const spent = sales
      .filter((s) => !s.refunded)
      .reduce((sum, s) => sum + (s.price || 0), 0);

    const lines = sales.map((s) => {
      const when = `<t:${Math.floor(new Date(s.createdAt).getTime() / 1000)}:R>`;
      const status = s.refunded ? " • ↩️ refunded" : "";
      const order = s.orderId ? ` \`${s.orderId}\`` : "";
      const qty = s.quantity && s.quantity > 1 ? ` ×${s.quantity}` : "";
      return `•${order} **${s.productName}**${qty} — ${s.price} ${config.currency} ${when}${status}`;
    });

    embed.setDescription(lines.join("\n")).addFields({
      name: "Total spent (excluding refunds)",
      value: `**${spent}** ${config.currency}`,
    });

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
