const { ApplicationCommandOptionType,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder, MessageFlags } = require("discord.js");
const { requireStaff } = require("../utils/permissions");
const { success, error } = require("../utils/embeds");
const stickySchema = require("../db/models/stickySchema");
const { invalidateStickyCache } = require("../utils/sticky");

// /stickmessage — manage a sticky message that stays at the bottom of a channel.
//   set [channel]  → opens a form to type the message; sets/updates the sticky
//   remove [channel] → stops sticking a message to that channel
// A sticky is re-posted whenever someone else sends a message, so it's always
// the last thing visible.
module.exports = {
  name: "stickmessage",
  category: "Staff",
  description: "Set or remove a sticky message that stays at the bottom of a channel",
  hidden: true,
  options: [
    {
      name: "set",
      description: "Set or edit the sticky message for a channel (opens a form)",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "channel",
          description: "Channel to stick the message to (defaults to here)",
          type: ApplicationCommandOptionType.Channel,
          channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
          required: false,
        },
      ],
    },
    {
      name: "remove",
      description: "Remove the sticky message from a channel",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "channel",
          description: "Channel to remove the sticky from (defaults to here)",
          type: ApplicationCommandOptionType.Channel,
          channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
          required: false,
        },
      ],
    },
  ],

  callback: async (client, interaction) => {
    if (!(await requireStaff(interaction))) return;

    const sub = interaction.options.getSubcommand();
    const channel = interaction.options.getChannel("channel") || interaction.channel;

    if (sub === "remove") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const existing = await stickySchema.findOne({ guildId: interaction.guild.id, channelId: channel.id });
      if (!existing) {
        return interaction.followUp({ embeds: [error(interaction, `There's no sticky message in ${channel}.`)], flags: MessageFlags.Ephemeral });
      }
      // Delete the last posted sticky message, then clear the record.
      if (existing.lastMessageId) {
        try {
          const ch = await client.channels.fetch(channel.id);
          const msg = await ch.messages.fetch(existing.lastMessageId);
          await msg.delete();
        } catch { /* already gone */ }
      }
      await stickySchema.findOneAndDelete({ guildId: interaction.guild.id, channelId: channel.id });
      invalidateStickyCache();
      return interaction.followUp({ embeds: [success(interaction, `Sticky message removed from ${channel}.`)], flags: MessageFlags.Ephemeral });
    }

    // sub === "set" — open a form pre-filled with the current sticky (if any).
    const existing = await stickySchema.findOne({ guildId: interaction.guild.id, channelId: channel.id });

    const modal = new ModalBuilder()
      .setCustomId(`sticky:set:${channel.id}`)
      .setTitle("Set Sticky Message");

    const contentInput = new TextInputBuilder()
      .setCustomId("content")
      .setLabel("Message to keep at the bottom of the channel")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("e.g. 📌 Read the rules before posting! Prices are final.")
      .setRequired(true)
      .setMaxLength(2000);
    if (existing?.content) contentInput.setValue(String(existing.content).slice(0, 2000));

    modal.addComponents(new ActionRowBuilder().addComponents(contentInput));
    return interaction.showModal(modal);
  },
};
