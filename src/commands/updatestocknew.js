const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const config = require("../config");
const { requireStaff } = require("../utils/permissions");
const { success, error } = require("../utils/embeds");
const { updateProduct, collectCodes } = require("../utils/products");
const { scheduleRefresh } = require("../utils/liveEmbeds");

module.exports = {
  name: "updatestocknew",
  category: "Staff",
  description: "Update product price and/or add stock (typed codes and/or a .txt file)",
  hidden: true,
  options: [
    {
      name: "code",
      description: "Product code to update",
      type: ApplicationCommandOptionType.String,
      required: true,
    },
    {
      name: "price",
      description: "New price (optional)",
      type: ApplicationCommandOptionType.Integer,
      required: false,
      minValue: 0,
    },
    {
      name: "codes",
      description: "Codes to append (separated by new lines or commas, optional)",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
    {
      name: "file",
      description: "A .txt file of codes (one per line) to append",
      type: ApplicationCommandOptionType.Attachment,
      required: false,
    },
  ],

  callback: async (client, interaction) => {
    if (!(await requireStaff(interaction))) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const codesRaw = interaction.options.getString("codes");
    const price = interaction.options.getInteger("price");
    const file = interaction.options.getAttachment("file");

    if (codesRaw == null && price == null && !file) {
      return interaction.followUp({
        embeds: [error(interaction, "Provide a new price and/or codes (typed or a .txt file).")],
        flags: MessageFlags.Ephemeral,
      });
    }

    let addCodes;
    try {
      addCodes = await collectCodes(codesRaw, file);
    } catch (err) {
      return interaction.followUp({ embeds: [error(interaction, err.message)], flags: MessageFlags.Ephemeral });
    }

    const result = await updateProduct({
      guildId: interaction.guild.id,
      productCode: interaction.options.getString("code"),
      updates: { productPrice: price ?? undefined },
      addCodes: addCodes.length > 0 ? addCodes : undefined,
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
          `Updated **${p.productName}** — price **${p.productPrice}** ${config.currency}, stock **${p.productStock}**.`
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};
