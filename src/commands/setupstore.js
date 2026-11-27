const { MessageFlags } = require("discord.js");
const { requireStaff } = require("../utils/permissions");
const { buildStoreEmbed } = require("../utils/embeds");
const { buildStoreComponents } = require("../utils/liveEmbeds");
const { getStoreStatus } = require("../utils/features");
const storeSchema = require("../db/models/storeSchema");
const guildConfigSchema = require("../db/models/guildConfigSchema");

module.exports = {
  name: "setupstore",
  category: "Staff",
  description: "Setup the store live embed",
  hidden: true,

  callback: async (client, interaction) => {
    if (!(await requireStaff(interaction))) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const storeData = await storeSchema.findOne({ guildId: interaction.guild.id });
    const products = storeData?.store || [];

    const status = await getStoreStatus(interaction.guild.id);
    const embed = buildStoreEmbed(interaction, products, undefined, undefined, status);
    const message = await interaction.channel.send({
      embeds: [embed],
      components: buildStoreComponents(products, "store:buy", status),
    });

    await guildConfigSchema.findOneAndUpdate(
      { guildId: interaction.guild.id },
      {
        $set: {
          storeChannelId: interaction.channel.id,
          storeMessageId: message.id,
        },
        $setOnInsert: { guildId: interaction.guild.id },
      },
      { upsert: true }
    );

    return interaction.followUp({
      content: "✅ Live store set up. It refreshes automatically as products and stock change.",
      flags: MessageFlags.Ephemeral,
    });
  },
};
