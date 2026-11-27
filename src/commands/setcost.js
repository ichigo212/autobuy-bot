const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const { requireStaff } = require("../utils/permissions");
const { baseEmbed, success, error } = require("../utils/embeds");
const { bmoney, money } = require("../utils/format");
const { findProduct, updateProduct } = require("../utils/products");
const storeSchema = require("../db/models/storeSchema");

// /setcost — what ONE item of a product costs you. Profit per sale is then
// price − cost, worked out automatically (and saved on every sale).
module.exports = {
  name: "setcost",
  category: "Staff",
  description: "Set what each item costs you, so profit is calculated automatically",
  hidden: true,
  options: [
    {
      name: "set",
      description: "Set the cost of one item of a product",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        { name: "code", description: "Product code", type: ApplicationCommandOptionType.String, required: true },
        { name: "cost", description: "What one item costs you (e.g. 35)", type: ApplicationCommandOptionType.Number, required: true, minValue: 0 },
      ],
    },
    {
      name: "reset",
      description: "Clear a product's cost (its sales won't count toward profit)",
      type: ApplicationCommandOptionType.Subcommand,
      options: [{ name: "code", description: "Product code", type: ApplicationCommandOptionType.String, required: true }],
    },
    { name: "list", description: "Show price, cost, profit and margin for every product", type: ApplicationCommandOptionType.Subcommand },
  ],

  callback: async (client, interaction) => {
    if (!(await requireStaff(interaction))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (sub === "list") {
      const products = (await storeSchema.findOne({ guildId }))?.store || [];
      if (!products.length) return interaction.editReply({ embeds: [error(interaction, "No products in the store yet.")] });
      const lines = products.map((p) => {
        if (p.cost == null) return `\`${p.productCode}\` **${p.productName}** — price ${money(p.productPrice)} · cost *not set*`;
        const profit = p.productPrice - p.cost;
        const margin = p.productPrice > 0 ? ` (${((profit / p.productPrice) * 100).toFixed(0)}%)` : "";
        return `\`${p.productCode}\` **${p.productName}** — price ${money(p.productPrice)} · cost ${money(p.cost)} · ${profit >= 0 ? "💹" : "🔻"} **${money(profit)}**${margin}`;
      });
      return interaction.editReply({
        embeds: [baseEmbed(interaction).setTitle("💹 Cost & profit per item").setDescription(lines.join("\n").slice(0, 4096))],
      });
    }

    const code = interaction.options.getString("code");
    const { product } = await findProduct(guildId, code);
    if (!product) return interaction.editReply({ embeds: [error(interaction, `Cannot find a product with code \`${code}\`.`)] });

    if (sub === "reset") {
      const result = await updateProduct({ guildId, productCode: code, updates: { cost: null } });
      if (!result.ok) return interaction.editReply({ embeds: [error(interaction, result.message)] });
      return interaction.editReply({ embeds: [success(interaction, `Cost cleared for **${product.productName}**.`)] });
    }

    const cost = interaction.options.getNumber("cost");
    const result = await updateProduct({ guildId, productCode: code, updates: { cost } });
    if (!result.ok) return interaction.editReply({ embeds: [error(interaction, result.message)] });

    const profit = product.productPrice - cost;
    const warn = profit < 0 ? "\n⚠️ That's **more than the price** — you lose money on every sale." : "";
    return interaction.editReply({
      embeds: [
        success(
          interaction,
          `**${product.productName}** costs you ${bmoney(cost)} · sells for ${bmoney(product.productPrice)} → ${bmoney(profit)} profit per item.${warn}\nApplies to new sales from now on.`
        ),
      ],
    });
  },
};
