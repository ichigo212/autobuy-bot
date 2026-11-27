const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const { buildStoreEmbed } = require("../utils/embeds");
const { buildStoreComponents } = require("../utils/liveEmbeds");
const { purchaseProduct, replyWithPurchase, MAX_QUANTITY } = require("../utils/purchase");
const { getStoreStatus } = require("../utils/features");
const storeSchema = require("../db/models/storeSchema");

module.exports = {
  name: "stock",
  category: "Economy",
  description: "View the stock list or buy a product by its code",
  hidden: false,
  options: [
    {
      name: "buy",
      description: "Buy a product by its code",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        { name: "code", description: "The product code (see /stock list)", type: ApplicationCommandOptionType.String, required: true },
        { name: "amount", description: "How many to buy (default 1)", type: ApplicationCommandOptionType.Integer, required: false, minValue: 1, maxValue: MAX_QUANTITY },
      ],
    },
    { name: "list", description: "Show every product and its stock", type: ApplicationCommandOptionType.Subcommand },
  ],

  callback: async (client, interaction) => {
    if (interaction.options.getSubcommand() === "list") {
      const products = (await storeSchema.findOne({ guildId: interaction.guild.id }))?.store || [];
      const status = await getStoreStatus(interaction.guild.id);
      return interaction.reply({
        embeds: [buildStoreEmbed(interaction, products, "📋 Stock List", undefined, status)],
        components: buildStoreComponents(products, "store:buy", status),
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await purchaseProduct({
      client,
      guildId: interaction.guild.id,
      userId: interaction.user.id,
      productCode: interaction.options.getString("code").trim(),
      quantity: interaction.options.getInteger("amount") || 1,
      guildName: interaction.guild.name,
    });
    return replyWithPurchase(interaction, result);
  },
};
