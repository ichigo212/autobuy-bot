const { ApplicationCommandOptionType, ChannelType, PermissionFlagsBits, MessageFlags } = require("discord.js");
const config = require("../config");
const { requireOwner, requireMainOwner, setAdmins, getAdmins } = require("../utils/permissions");
const { success, error, baseEmbed } = require("../utils/embeds");
const { logEvent } = require("../utils/logger");
const announce = require("../utils/announce");
const guildConfigSchema = require("../db/models/guildConfigSchema");

const EPHEMERAL = MessageFlags.Ephemeral;

const targetOptions = [
  { name: "user-or-role", description: "Pick a user or a role", type: ApplicationCommandOptionType.Mentionable, required: false },
  { name: "id", description: "…or paste a Discord user ID or role ID", type: ApplicationCommandOptionType.String, required: false },
];

// Resolves the user/role picked (or pasted as an ID) into { kind, id, label }.
const resolveTarget = async (client, interaction) => {
  const picked = interaction.options.get("user-or-role");
  if (picked?.role) return { kind: "role", id: picked.role.id, label: `<@&${picked.role.id}>`, role: picked.role };
  if (picked?.user) return { kind: "user", id: picked.user.id, label: `<@${picked.user.id}>`, user: picked.user };

  const raw = (interaction.options.getString("id") || "").replace(/[<@&!>\s]/g, "");
  if (!raw) return { error: "Pick a user or role, or paste their ID in the `id` box." };
  if (!/^\d{17,20}$/.test(raw)) return { error: "That doesn't look like a Discord ID. IDs are 17–20 digits (right-click → Copy ID)." };

  const role = await interaction.guild.roles.fetch(raw).catch(() => null);
  if (role) return { kind: "role", id: role.id, label: `<@&${role.id}>`, role };
  const user = await client.users.fetch(raw).catch(() => null);
  if (user) return { kind: "user", id: user.id, label: `<@${user.id}>`, user };
  return { error: `No user or role with the ID \`${raw}\` was found.` };
};

const saveAdmins = async (guildId, update) => {
  const doc = await guildConfigSchema.findOneAndUpdate({ guildId }, { ...update, $setOnInsert: { guildId } }, { upsert: true, new: true });
  setAdmins(guildId, doc.adminUserIds, doc.adminRoleIds);
  return doc;
};

module.exports = {
  name: "announcement",
  category: "Admin",
  description: "Send an announcement (with a picture) to a channel or DM every member · manage bot admins",
  hidden: true,
  options: [
    {
      name: "send",
      description: "Write an announcement in a form, preview it, then send it",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "send-to",
          description: "Where should the announcement go?",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: "📢 Post in a channel", value: "channel" },
            { name: "📨 DM every member", value: "dm" },
            { name: "📢 + 📨 Both", value: "both" },
          ],
        },
        {
          name: "channel",
          description: "Channel to post in (defaults to this channel)",
          type: ApplicationCommandOptionType.Channel,
          channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
          required: false,
        },
        {
          name: "ping",
          description: "Ping people in the channel post (default: no ping)",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: [
            { name: "No ping", value: "none" },
            { name: "@everyone", value: "everyone" },
            { name: "@here", value: "here" },
          ],
        },
      ],
    },
    { name: "addowner", description: "Give a user or role full owner + staff access to this bot", type: ApplicationCommandOptionType.Subcommand, options: targetOptions },
    { name: "removeowner", description: "Take owner access away from a user or role", type: ApplicationCommandOptionType.Subcommand, options: targetOptions },
    { name: "owners", description: "List who has owner access to this bot", type: ApplicationCommandOptionType.Subcommand },
  ],

  callback: async (client, interaction) => {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;

    // ---- send ----------------------------------------------------------------
    if (sub === "send") {
      if (!(await requireOwner(interaction))) return;
      if (announce.isBroadcasting(guild.id)) {
        return interaction.reply({ embeds: [error(interaction, "Another announcement is still being sent in this server. Wait for it to finish (or stop it) first.")], flags: EPHEMERAL });
      }
      const target = interaction.options.getString("send-to");
      const ping = interaction.options.getString("ping") || "none";
      const channel = interaction.options.getChannel("channel") || interaction.channel;

      if (target !== "dm") {
        const perms = channel?.permissionsFor?.(guild.members.me);
        const need = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles];
        if (ping !== "none") need.push(PermissionFlagsBits.MentionEveryone);
        if (!perms || !need.every((p) => perms.has(p))) {
          return interaction.reply({
            embeds: [error(interaction, `I can't post in ${channel}. I need **View Channel, Send Messages, Embed Links, Attach Files**${ping !== "none" ? " and **Mention @everyone**" : ""} there.`)],
            flags: EPHEMERAL,
          });
        }
      }

      const draft = announce.startDraft({ guildId: guild.id, userId: interaction.user.id, target, channelId: channel?.id, ping });
      return announce.openForm(interaction, draft);
    }

    // ---- owners --------------------------------------------------------------
    if (sub === "owners") {
      if (!(await requireOwner(interaction))) return;
      const { users, roles } = getAdmins(guild.id);
      const embed = baseEmbed(interaction)
        .setTitle("👑 Bot owners & admins")
        .addFields(
          { name: "Main owners (.env)", value: config.ownerIds.map((id) => `<@${id}>`).join("\n") || "*None set*", inline: true },
          { name: "Admin users", value: users.map((id) => `<@${id}>`).join("\n") || "*None*", inline: true },
          { name: "Admin roles", value: roles.map((id) => `<@&${id}>`).join("\n") || "*None*", inline: true }
        )
        .setFooter({ text: "Admins have full owner + staff access. Only main owners can add/remove them." });
      return interaction.reply({ embeds: [embed], flags: EPHEMERAL, allowedMentions: { parse: [] } });
    }

    // ---- addowner / removeowner ----------------------------------------------
    if (!(await requireMainOwner(interaction))) return;
    await interaction.deferReply({ flags: EPHEMERAL });

    const t = await resolveTarget(client, interaction);
    if (t.error) return interaction.editReply({ embeds: [error(interaction, t.error)] });
    if (t.kind === "role" && t.id === guild.id) return interaction.editReply({ embeds: [error(interaction, "You can't make **@everyone** an admin. That would give the whole server full access.")] });
    if (t.kind === "user" && t.user?.bot) return interaction.editReply({ embeds: [error(interaction, "Bots can't be admins.")] });

    const field = t.kind === "role" ? "adminRoleIds" : "adminUserIds";
    const current = getAdmins(guild.id)[t.kind === "role" ? "roles" : "users"];

    if (sub === "addowner") {
      if (t.kind === "user" && config.ownerIds.includes(t.id)) return interaction.editReply({ embeds: [error(interaction, `${t.label} is already a main owner.`)] });
      if (current.includes(t.id)) return interaction.editReply({ embeds: [error(interaction, `${t.label} is already an admin.`)] });
      await saveAdmins(guild.id, { $addToSet: { [field]: t.id } });
      logEvent(client, guild.id, { type: "admin", title: "Admin added", actorId: interaction.user.id, description: `${t.label} now has owner + staff access.` });
      return interaction.editReply({
        embeds: [
          success(
            interaction,
            `${t.label} is now a **bot admin**${t.kind === "role" ? " (everyone with this role)" : ""}.\nThey get **full owner + staff access**: every command, including \`/announcement\`. Only main owners can add or remove admins.`
          ),
        ],
        allowedMentions: { parse: [] },
      });
    }

    // removeowner
    if (t.kind === "user" && config.ownerIds.includes(t.id)) {
      return interaction.editReply({ embeds: [error(interaction, `${t.label} is a main owner from the bot's \`.env\` (OWNER_IDS). Remove them there instead.`)] });
    }
    if (!current.includes(t.id)) return interaction.editReply({ embeds: [error(interaction, `${t.label} isn't an admin.`)] });
    await saveAdmins(guild.id, { $pull: { [field]: t.id } });
    logEvent(client, guild.id, { type: "admin", title: "Admin removed", actorId: interaction.user.id, description: `${t.label} no longer has owner access.` });
    return interaction.editReply({ embeds: [success(interaction, `${t.label} is no longer a bot admin.`)], allowedMentions: { parse: [] } });
  },
};
