const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const config = require("../config");
const { requireStaff } = require("../utils/permissions");
const { success, error } = require("../utils/embeds");
const { updateProduct, collectCodes } = require("../utils/products");
const { scheduleRefresh } = require("../utils/liveEmbeds");

module.exports = {
  name: "updateproduct",
  category: "Staff",
  description: "Update any field of a product (name, price, stock, codes, emoji…)",
  hidden: true,
  options: [
    {
      name: "code",
      description: "Product code to update",
      type: ApplicationCommandOptionType.String,
      required: true,
    },
    {
      name: "name",
      description: "New product name",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
    {
      name: "new-code",
      description: "New product code",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
    {
      name: "price",
      description: "New price",
      type: ApplicationCommandOptionType.Integer,
      required: false,
      minValue: 0,
    },
    {
      name: "codes",
      description: "REPLACE all items (comma-separated)",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
    {
      name: "file",
      description: "REPLACE all items from a .txt file (one item per line)",
      type: ApplicationCommandOptionType.Attachment,
      required: false,
    },
    {
      name: "emoji",
      description: "New emoji shown in the store",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
    {
      name: "description",
      description: "New short description shown in the store",
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

    let newCodes;
    if (codesRaw != null || file) {
      try {
        newCodes = await collectCodes(codesRaw, file);
      } catch (err) {
        return interaction.followUp({ embeds: [error(interaction, err.message)], flags: MessageFlags.Ephemeral });
      }
    }

    if (Array.isArray(newCodes) && newCodes.length === 0) {
      return interaction.followUp({ embeds: [error(interaction, "No items found in what you gave — stock was NOT changed.")], flags: MessageFlags.Ephemeral });
    }

    const result = await updateProduct({
      guildId: interaction.guild.id,
      productCode: interaction.options.getString("code"),
      updates: {
        productName: interaction.options.getString("name") ?? undefined,
        productCode: interaction.options.getString("new-code") ?? undefined,
        productPrice: interaction.options.getInteger("price") ?? undefined,
        emoji: interaction.options.getString("emoji") ?? undefined,
        description: interaction.options.getString("description") ?? undefined,
        cost: interaction.options.getNumber("cost") ?? undefined,
      },
      newCodes,
    });

    if (!result.ok) {
      return interaction.followUp({ embeds: [error(interaction, result.message)], flags: MessageFlags.Ephemeral });
    }

    scheduleRefresh(client, interaction.guild.id);

    const p = result.product;
    return interaction.followUp({
      embeds: [
        success(
          interaction,
          `Updated **${p.productName}** (\`${p.productCode}\`) — price **${p.productPrice}** ${config.currency}, stock **${p.productStock}**.`
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};
