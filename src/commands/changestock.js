const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const { requireStaff } = require("../utils/permissions");
const { success, error } = require("../utils/embeds");
const { updateProduct, collectCodes } = require("../utils/products");
const { scheduleRefresh } = require("../utils/liveEmbeds");

module.exports = {
  name: "changestock",
  category: "Staff",
  description: "Replace product codes (typed codes and/or a .txt file)",
  hidden: true,
  options: [
    {
      name: "code",
      description: "Product code to update",
      type: ApplicationCommandOptionType.String,
      required: true,
    },
    {
      name: "codes",
      description: "New codes that REPLACE the existing ones (new lines or commas)",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
    {
      name: "file",
      description: "A .txt file of codes (one per line) that REPLACES existing codes",
      type: ApplicationCommandOptionType.Attachment,
      required: false,
    },
  ],

  callback: async (client, interaction) => {
    if (!(await requireStaff(interaction))) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const codesRaw = interaction.options.getString("codes");
    const file = interaction.options.getAttachment("file");

    if (codesRaw == null && !file) {
      return interaction.followUp({
        embeds: [error(interaction, "Provide the new codes (typed or as a .txt file).")],
        flags: MessageFlags.Ephemeral,
      });
    }

    let newCodes;
    try {
      newCodes = await collectCodes(codesRaw, file);
    } catch (err) {
      return interaction.followUp({ embeds: [error(interaction, err.message)], flags: MessageFlags.Ephemeral });
    }

    if (newCodes.length === 0) {
      return interaction.followUp({ embeds: [error(interaction, "No items found — stock was NOT changed.")], flags: MessageFlags.Ephemeral });
    }

    const result = await updateProduct({
      guildId: interaction.guild.id,
      productCode: interaction.options.getString("code"),
      newCodes,
    });

    if (!result.ok) {
      return interaction.followUp({ embeds: [error(interaction, result.message)], flags: MessageFlags.Ephemeral });
    }

    scheduleRefresh(client, interaction.guild.id);

    return interaction.followUp({
      embeds: [
        success(
          interaction,
          `Replaced codes for **${result.product.productName}**. Stock is now **${result.product.productStock}**.`
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};
