const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const { requireStaff } = require("../utils/permissions");
const { success, error, baseEmbed } = require("../utils/embeds");
const { buildStoreEmbed } = require("../utils/embeds");
const { buildStoreComponents } = require("../utils/liveEmbeds");
const { parseTypedCodes } = require("../utils/products");
const { getStoreStatus } = require("../utils/features");
const storeSchema = require("../db/models/storeSchema");
const guildConfigSchema = require("../db/models/guildConfigSchema");

// Creates a custom "shop" — a curated subset of products posted as its own
// live embed in the current channel. Codes list which products it includes.
module.exports = {
  name: "createshop",
  category: "Staff",
  description: "Create custom shop",
  hidden: true,
  options: [
    {
      name: "name",
      description: "Shop name",
      type: ApplicationCommandOptionType.String,
      required: true,
    },
    {
      name: "products",
      description: "Product codes to include (comma-separated). Leave empty for all.",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
    {
      name: "description",
      description: "Shop description",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
  ],

  callback: async (client, interaction) => {
    if (!(await requireStaff(interaction))) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const name = interaction.options.getString("name");
    const description = interaction.options.getString("description") || "";
    const productCodes = parseTypedCodes(interaction.options.getString("products"));

    const storeData = await storeSchema.findOne({ guildId: interaction.guild.id });
    const allProducts = storeData?.store || [];

    // Filter to the shop's products (or everything if none specified).
    const shopProducts =
      productCodes.length > 0
        ? allProducts.filter((p) => productCodes.includes(p.productCode))
        : allProducts;

    if (productCodes.length > 0 && shopProducts.length === 0) {
      return interaction.followUp({
        embeds: [error(interaction, "None of those product codes exist.")],
        flags: MessageFlags.Ephemeral,
      });
    }

    const status = await getStoreStatus(interaction.guild.id);
    const embed = buildStoreEmbed(interaction, shopProducts, `🛒 ${name}`, description || undefined, status);

    const message = await interaction.channel.send({
      embeds: [embed],
      components: buildStoreComponents(shopProducts, "store:buy", status),
    });

    await guildConfigSchema.findOneAndUpdate(
      { guildId: interaction.guild.id },
      {
        $setOnInsert: { guildId: interaction.guild.id },
        $push: {
          shops: {
            name,
            description,
            productCodes,
            channelId: interaction.channel.id,
            messageId: message.id,
          },
        },
      },
      { upsert: true }
    );

    return interaction.followUp({
      embeds: [success(interaction, `Created custom shop **${name}** with **${shopProducts.length}** products.`)],
      flags: MessageFlags.Ephemeral,
    });
  },
};
