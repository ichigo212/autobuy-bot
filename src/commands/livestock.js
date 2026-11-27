const { ApplicationCommandOptionType, ChannelType, MessageFlags } = require("discord.js");
const { requireStaff } = require("../utils/permissions");
const { error, success } = require("../utils/embeds");
const { buildLiveStockEmbed, buildLiveStockComponents } = require("../utils/liveEmbeds");
const { getStoreStatus } = require("../utils/features");
const storeSchema = require("../db/models/storeSchema");
const guildConfigSchema = require("../db/models/guildConfigSchema");

// /livestock [channel] — Posts a live stock-status embed (product name, price,
// stock badge for every product) and re-renders it in place automatically
// whenever stock changes (purchase, restock, edit). The channel can be specified
// as a channel mention/picker OR as a raw channel ID string for flexibility.
module.exports = {
  name: "livestock",
  category: "Staff",
  description: "Post a live stock status board that auto-updates as stock changes",
  hidden: true,
  options: [
    {
      name: "channel",
      description: "Channel to post the live stock board in (defaults to here)",
      type: ApplicationCommandOptionType.Channel,
      channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
      required: false,
    },
    {
      name: "channelid",
      description: "Paste a raw channel ID instead of picking from the list",
      type: ApplicationCommandOptionType.String,
      required: false,
    },
  ],

  callback: async (client, interaction) => {
    if (!(await requireStaff(interaction))) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Resolve the target channel — picker wins over raw id.
    let channel = interaction.options.getChannel("channel");
    if (!channel) {
      const rawId = interaction.options.getString("channelid");
      if (rawId) {
        try { channel = await client.channels.fetch(rawId.trim()); }
        catch { return interaction.followUp({ embeds: [error(interaction, `Cannot find a channel with ID \`${rawId.trim()}\`.`)], flags: MessageFlags.Ephemeral }); }
      } else {
        channel = interaction.channel;
      }
    }

    // Make sure the bot can actually post there.
    const me = interaction.guild.members.me;
    if (!channel.permissionsFor(me)?.has("SendMessages")) {
      return interaction.followUp({ embeds: [error(interaction, `I can't send messages in ${channel}. Fix my permissions first.`)], flags: MessageFlags.Ephemeral });
    }

    const storeData = await storeSchema.findOne({ guildId: interaction.guild.id });
    const products = storeData?.store || [];

    const embed = buildLiveStockEmbed({ guild: channel.guild }, products);
    const message = await channel.send({
      embeds: [embed],
      components: buildLiveStockComponents(products, await getStoreStatus(interaction.guild.id)),
    });

    await guildConfigSchema.findOneAndUpdate(
      { guildId: interaction.guild.id },
      {
        $set: { liveStockChannelId: channel.id, liveStockMessageId: message.id },
        $setOnInsert: { guildId: interaction.guild.id },
      },
      { upsert: true }
    );

    return interaction.followUp({
      embeds: [success(interaction, `Live stock board posted in ${channel}. It will refresh automatically whenever stock changes.`)],
      flags: MessageFlags.Ephemeral,
    });
  },
};
