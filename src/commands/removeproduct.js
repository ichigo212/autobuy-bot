const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const { requireStaff } = require("../utils/permissions");
const { success, error } = require("../utils/embeds");
const { removeProduct } = require("../utils/products");
const { scheduleRefresh } = require("../utils/liveEmbeds");

module.exports = {
  name: "removeproduct",
  category: "Staff",
  description: "Remove a product from the store",
  hidden: true,
  options: [
    {
      name: "code",
      description: "Product code to remove",
      type: ApplicationCommandOptionType.String,
      required: true,
    },
  ],

  callback: async (client, interaction) => {
    if (!(await requireStaff(interaction))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const result = await removeProduct({
      guildId: interaction.guild.id,
      productCode: interaction.options.getString("code"),
    });

    if (!result.ok) {
      return interaction.editReply({ embeds: [error(interaction, result.message)], flags: MessageFlags.Ephemeral });
    }

    scheduleRefresh(client, interaction.guild.id);

    return interaction.editReply({
      embeds: [
        success(interaction, `Removed **${result.product.productName}** (\`${result.product.productCode}\`).`),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },
};
