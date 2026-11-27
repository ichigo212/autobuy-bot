const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const config = require("../config");
const { requireStaff } = require("../utils/permissions");
const { success, error } = require("../utils/embeds");
const { bmoney } = require("../utils/format");
const { addProduct, collectCodes } = require("../utils/products");
const { scheduleRefresh } = require("../utils/liveEmbeds");

module.exports = {
  name: "addproduct",
  category: "Staff",
  description: "Add a new product to the store",
  hidden: true,
  options: [
    {
      name: "name",
      description: "Product name",
      type: ApplicationCommandOptionType.String,
      required: true,
    },
    {
      name: "code",
      description: "Unique product code (letters, numbers, - or _; e.g. NITRO1M)",
      type: ApplicationCommandOptionType.String,
      required: true,
    },
    {
      name: "price",
      description: `Price in ${config.currency}`,
      type: ApplicationCommandOptionType.Integer,
      required: true,
      minValue: 0,
    },
    {
      name: "codes",
      description: "Items to sell, separated by commas (or upload a .txt, one item per line)",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
    {
      name: "file",
      description: "A .txt file of codes (one per line) to deliver (optional)",
      type: ApplicationCommandOptionType.Attachment,
      required: false,
    },
    {
      name: "emoji",
      description: "An emoji shown next to the product in the store (optional)",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
    {
      name: "description",
      description: "A short description shown in the store (optional)",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
    {
      name: "cost",
      description: "What ONE item costs you — profit is worked out automatically (price − cost)",
      type: ApplicationCommandOptionType.Number,
      required: false,
      minValue: 0,
    },
  ],

  callback: async (client, interaction) => {
    if (!(await requireStaff(interaction))) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const codesRaw = interaction.options.getString("codes");
    const file = interaction.options.getAttachment("file");

    let codes;
    try {
      codes = await collectCodes(codesRaw, file);
    } catch (err) {
      return interaction.followUp({ embeds: [error(interaction, err.message)], flags: MessageFlags.Ephemeral });
    }

    const result = await addProduct({
      guildId: interaction.guild.id,
      productName: interaction.options.getString("name"),
      productCode: interaction.options.getString("code"),
      productPrice: interaction.options.getInteger("price"),
      // When no codes are supplied, fall back to a plain numeric-stock product.
      codes,
      emoji: interaction.options.getString("emoji") || undefined,
      description: interaction.options.getString("description") || undefined,
      cost: interaction.options.getNumber("cost") ?? undefined,
    });

    if (!result.ok) {
      return interaction.followUp({ embeds: [error(interaction, result.message)], flags: MessageFlags.Ephemeral });
    }

    scheduleRefresh(client, interaction.guild.id);

    return interaction.followUp({
      embeds: [
        success(
          interaction,
          `Added **${result.product.productName}** (\`${result.product.productCode}\`) at ${bmoney(result.product.productPrice)} with **${result.product.productStock}** in stock.${result.product.productStock === 0 ? "\nℹ️ No stock yet — add items with `/updatestocknew`." : ""}`
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};
