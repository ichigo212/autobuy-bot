const { ApplicationCommandOptionType, ChannelType, MessageFlags } = require("discord.js");
const { requireStaff } = require("../utils/permissions");
const { error } = require("../utils/embeds");
const { newDraft, setDraft, renderPreview } = require("../utils/embedBuilder");

// Interactive embed builder. /embed [channel] opens an ephemeral live preview
// with buttons to edit content/appearance, add custom link (referral/website)
// buttons, and post the finished embed to a channel. The button/modal lifecycle
// is handled in events/interaction/interactionCreate.js via utils/embedBuilder.
module.exports = {
  name: "embed",
  category: "Staff",
  description: "Build a custom embed with link buttons and post it to a channel",
  hidden: true,
  options: [
    {
      name: "channel",
      description: "Channel to post the finished embed to (defaults to here)",
      type: ApplicationCommandOptionType.Channel,
      channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
      required: false,
    },
  ],

  callback: async (client, interaction) => {
    if (!(await requireStaff(interaction))) return;

    const channel = interaction.options.getChannel("channel") || interaction.channel;

    // Guard: make sure the bot can actually send to the chosen channel.
    const me = interaction.guild.members.me;
    if (!channel.permissionsFor(me)?.has("SendMessages")) {
      return interaction.reply({
        embeds: [error(interaction, `I can't send messages in ${channel}. Pick another channel or fix my permissions.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    const draft = newDraft(channel.id);
    setDraft(interaction.user.id, draft);

    return interaction.reply({ ...renderPreview(draft), flags: MessageFlags.Ephemeral });
  },
};
