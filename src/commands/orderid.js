const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const { isStaff } = require("../utils/permissions");
const { baseEmbed, error, COLORS } = require("../utils/embeds");
const { bmoney, ts } = require("../utils/format");
const { buildDeliveryComponents } = require("../utils/liveEmbeds");
const saleSchema = require("../db/models/saleSchema");

// /orderid <id> — full details for an order. Buyers can view (and re-copy the
// items of) their own orders; staff can view any order in the server.
module.exports = {
  name: "orderid",
  category: "Economy",
  description: "Look up an order by its ID and get your items again",
  hidden: false,
  options: [{ name: "id", description: "The order ID (e.g. #A1B2C3D4E5F6)", type: ApplicationCommandOptionType.String, required: true }],

  callback: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const raw = interaction.options.getString("id").trim().toUpperCase();
    const orderId = raw.startsWith("#") ? raw : `#${raw}`;
    const sale = await saleSchema.findOne({ guildId: interaction.guild.id, orderId });
    if (!sale) return interaction.editReply({ embeds: [error(interaction, `No order \`${orderId}\` found in this server.`)] });

    const staff = isStaff(interaction);
    const own = sale.userId === interaction.user.id;
    if (!own && !staff) return interaction.editReply({ embeds: [error(interaction, "That order belongs to someone else.")] });

    const status = sale.refunded
      ? `↩️ Refunded ${sale.refundedAt ? ts(sale.refundedAt) : ""}${sale.restocked ? " (restocked)" : ""}`
      : sale.delivered
      ? "✅ Delivered by DM"
      : "⚠️ DM failed — shown in channel";

    const embed = baseEmbed(interaction)
      .setColor(sale.refunded ? COLORS.warning : sale.delivered ? COLORS.success : COLORS.warning)
      .setTitle(`📦 Order ${orderId}`)
      .addFields(
        { name: "Product", value: `${sale.productName} (\`${sale.productCode}\`)`, inline: true },
        { name: "Quantity", value: `×${sale.quantity || 1}`, inline: true },
        { name: "Total paid", value: bmoney(sale.price), inline: true },
        { name: "Status", value: status, inline: true },
        { name: "Ordered", value: `${ts(sale.createdAt, "f")} (${ts(sale.createdAt)})`, inline: true },
        { name: "Buyer", value: `<@${sale.userId}>`, inline: true }
      );
    if (sale.refunded && sale.refundedBy) embed.addFields({ name: "Refunded by", value: `<@${sale.refundedBy}>`, inline: true });

    const codes = sale.deliveredCodes?.length ? sale.deliveredCodes : sale.deliveredCode ? [sale.deliveredCode] : [];
    if (codes.length && (staff || (own && !sale.refunded))) {
      const joined = codes.join("\n");
      embed.addFields({
        name: own ? "🔑 Your item(s)" : "🔑 Delivered item(s) (staff view)",
        value: `\`\`\`\n${joined.length > 1000 ? `${joined.slice(0, 1000)}\n…` : joined}\n\`\`\``,
      });
    }

    return interaction.editReply({ embeds: [embed], components: own && codes.length && !sale.refunded ? buildDeliveryComponents({ orderId }) : [] });
  },
};
