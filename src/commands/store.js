const { MessageFlags } = require("discord.js");
const { buildStoreEmbed } = require("../utils/embeds");
const { buildStoreComponents } = require("../utils/liveEmbeds");
const { getStoreStatus } = require("../utils/features");
const storeSchema = require("../db/models/storeSchema");

module.exports = {
  name: "store",
  category: "Economy",
  description: "Browse the store and buy instantly",
  hidden: false,

  callback: async (client, interaction) => {
    const products = (await storeSchema.findOne({ guildId: interaction.guild.id }))?.store || [];
    const status = await getStoreStatus(interaction.guild.id);
    return interaction.reply({
      embeds: [buildStoreEmbed(interaction, products, undefined, undefined, status)],
      components: buildStoreComponents(products, "store:buy", status),
      flags: MessageFlags.Ephemeral,
    });
  },
};
