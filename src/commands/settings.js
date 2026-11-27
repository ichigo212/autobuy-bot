const { ApplicationCommandOptionType, ChannelType, MessageFlags, PermissionFlagsBits } = require("discord.js");
const config = require("../config");
const { requireOwner } = require("../utils/permissions");
const { baseEmbed, success, error } = require("../utils/embeds");
const { logEvent } = require("../utils/logger");
const { scheduleRefresh } = require("../utils/liveEmbeds");
const guildConfigSchema = require("../db/models/guildConfigSchema");
const { autoSettings } = require("../utils/topups");
const { peso: money } = require("../utils/format");

const autoText = (cfg) => {
  const a = autoSettings(cfg);
  return a.on ? `On · up to ${money(a.max)} · receipts ≤ ${a.maxAgeMin} min old` : "Off: every top-up checked by staff";
};

const textChannel = { type: ApplicationCommandOptionType.Channel, channelTypes: [ChannelType.GuildText, ChannelType.GuildAnnouncement] };

// /settings — one place to see and change the bot's server settings.
module.exports = {
  name: "settings",
  category: "Admin",
  description: "(Owner) View and change the bot's settings for this server",
  hidden: true,
  options: [
    { name: "view", description: "Show every setting at a glance", type: ApplicationCommandOptionType.Subcommand },
    {
      name: "store",
      description: "Open or close the store (closed = nobody can buy)",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "status",
          description: "Open or closed",
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [{ name: "🟢 Open", value: "open" }, { name: "🔒 Closed", value: "closed" }],
        },
        { name: "message", description: "Shown to buyers while closed (e.g. Restocking, back at 8PM)", type: ApplicationCommandOptionType.String, required: false, maxLength: 200 },
      ],
    },
    {
      name: "reviews-channel",
      description: "Where buyers' reviews (vouches) are posted. Leave empty to turn reviews off",
      type: ApplicationCommandOptionType.Subcommand,
      options: [{ ...textChannel, name: "channel", description: "The reviews / vouches channel", required: false }],
    },
    {
      name: "approval-channel",
      description: "Where GCash top-ups go for approval (and auto-approved ones, with Undo)",
      type: ApplicationCommandOptionType.Subcommand,
      options: [{ ...textChannel, name: "channel", description: "A private staff channel", required: true }],
    },
    {
      name: "sales-channel",
      description: "Get a notification for every sale. Leave empty to turn off",
      type: ApplicationCommandOptionType.Subcommand,
      options: [{ ...textChannel, name: "channel", description: "A private channel only you/staff can see", required: false }],
    },
    {
      name: "auto-approve",
      description: "Auto-approve GCash top-ups whose receipt checks out",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        { name: "enabled", description: "On or off", type: ApplicationCommandOptionType.Boolean, required: true },
        { name: "max", description: "Biggest top-up (₱) approved automatically. Bigger ones go to staff (default 1000)", type: ApplicationCommandOptionType.Integer, required: false, minValue: 1, maxValue: 1000000 },
        { name: "max-age-minutes", description: "Receipts older than this go to staff (default 120)", type: ApplicationCommandOptionType.Integer, required: false, minValue: 5, maxValue: 10080 },
      ],
    },
    {
      name: "customer-role",
      description: "Role given automatically after a purchase. Leave empty to turn off",
      type: ApplicationCommandOptionType.Subcommand,
      options: [{ name: "role", description: "e.g. @Customer", type: ApplicationCommandOptionType.Role, required: false }],
    },
  ],

  callback: async (client, interaction) => {
    if (!(await requireOwner(interaction))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = interaction.guild.id;
    const sub = interaction.options.getSubcommand();
    const save = (set) => guildConfigSchema.findOneAndUpdate({ guildId }, { $set: set, $setOnInsert: { guildId } }, { upsert: true, new: true });

    if (sub === "store") {
      const open = interaction.options.getString("status") === "open";
      const message = interaction.options.getString("message") || "";
      await save({ storeOpen: open, storeClosedMessage: open ? "" : message });
      scheduleRefresh(client, guildId);
      logEvent(client, guildId, { type: "admin", title: open ? "Store Opened" : "Store Closed", actorId: interaction.user.id, description: message || undefined });
      return interaction.editReply({
        embeds: [success(interaction, open ? "🟢 The store is **open** — buying is enabled." : `🔒 The store is **closed** — nobody can buy until you reopen it.${message ? `\nMessage: *${message}*` : ""}`)],
      });
    }

    if (sub === "reviews-channel") {
      const channel = interaction.options.getChannel("channel");
      if (channel && !channel.permissionsFor(interaction.guild.members.me)?.has(["SendMessages", "EmbedLinks"])) {
        return interaction.editReply({ embeds: [error(interaction, `I can't post embeds in ${channel}. Fix my permissions first.`)] });
      }
      await save({ vouchChannelId: channel?.id || null });
      return interaction.editReply({
        embeds: [success(interaction, channel ? `⭐ Buyers get a **Leave a review** button on their delivery, and reviews are posted in ${channel}.` : "Reviews turned off.")],
      });
    }

    if (sub === "approval-channel" || sub === "sales-channel") {
      const channel = interaction.options.getChannel("channel");
      const need = sub === "approval-channel" ? ["ViewChannel", "SendMessages", "EmbedLinks", "AttachFiles"] : ["ViewChannel", "SendMessages", "EmbedLinks"];
      if (channel && !channel.permissionsFor(interaction.guild.members.me)?.has(need)) {
        return interaction.editReply({ embeds: [error(interaction, `I can't post in ${channel}. I need **${need.join(", ").replace(/([a-z])([A-Z])/g, "$1 $2")}** there.`)] });
      }
      if (sub === "approval-channel") {
        await save({ topupChannelId: channel.id });
        logEvent(client, guildId, { type: "admin", title: "Approval channel set", actorId: interaction.user.id, description: `${channel}` });
        return interaction.editReply({
          embeds: [success(interaction, `💙 GCash top-ups now go to ${channel}: ones that need approval (with **Approve / Decline**) and auto-approved ones (with **Undo**).
⚠️ Keep this channel **private**: it shows receipts.`)],
        });
      }
      await save({ salesChannelId: channel?.id || null });
      logEvent(client, guildId, { type: "admin", title: channel ? "Sales channel set" : "Sales channel turned off", actorId: interaction.user.id, description: channel ? `${channel}` : undefined });
      return interaction.editReply({
        embeds: [success(interaction, channel ? `🛒 Every sale will be posted in ${channel} (buyer, product, total and **profit**). Keep it private.` : "Sale notifications turned off.")],
      });
    }

    if (sub === "auto-approve") {
      const enabled = interaction.options.getBoolean("enabled");
      const set = { autoApprove: enabled };
      const max = interaction.options.getInteger("max");
      const age = interaction.options.getInteger("max-age-minutes");
      if (max != null) set.autoApproveMax = max;
      if (age != null) set.receiptMaxAgeMin = age;
      const doc = await save(set);
      const a = autoSettings(doc);
      logEvent(client, guildId, { type: "admin", title: `Auto-approve ${a.on ? "on" : "off"}`, actorId: interaction.user.id, description: a.on ? `Up to ${money(a.max)}, receipts up to ${a.maxAgeMin} min old` : undefined });
      return interaction.editReply({
        embeds: [
          success(
            interaction,
            a.on
              ? `⚡ **Auto-approve is on.** GCash top-ups up to **${money(a.max)}** are credited instantly when the receipt checks out:\n• it's a GCash / InstaPay receipt\n• the amount matches\n• it was sent to **${config.gcash.number || "your GCASH_NUMBER"}**\n• it's at most **${a.maxAgeMin} min** old\n• the Ref No. and screenshot were never used before\n\nAnything else (or over ${money(a.max)}) goes to the approval channel.`
              : "Auto-approve is **off**. Every top-up goes to the approval channel for a person to check."
          ),
        ],
      });
    }

    if (sub === "customer-role") {
      const role = interaction.options.getRole("role");
      if (role) {
        const me = interaction.guild.members.me;
        if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
          return interaction.editReply({ embeds: [error(interaction, "I need the **Manage Roles** permission to give roles.")] });
        }
        if (role.managed || role.position >= me.roles.highest.position) {
          return interaction.editReply({ embeds: [error(interaction, `Move my role **above** ${role} in Server Settings → Roles, then try again.`)] });
        }
      }
      await save({ customerRoleId: role?.id || null });
      return interaction.editReply({ embeds: [success(interaction, role ? `🏷️ Buyers will get ${role} after their first purchase.` : "Customer role turned off.")] });
    }

    // view
    const cfg = (await guildConfigSchema.findOne({ guildId }).lean()) || {};
    const ch = (id) => (id ? `<#${id}>` : "*not set*");
    const embed = baseEmbed(interaction)
      .setTitle("⚙️ Bot settings")
      .addFields(
        { name: "🛒 Store", value: cfg.storeOpen === false ? `🔒 Closed${cfg.storeClosedMessage ? ` — *${cfg.storeClosedMessage}*` : ""}` : "🟢 Open", inline: true },
        { name: "📋 Log channel", value: ch(cfg.logChannelId), inline: true },
        { name: "📅 Daily report", value: cfg.dailyReport ? "On" : "Off", inline: true },
        { name: "💙 Approval channel", value: ch(cfg.topupChannelId || cfg.logChannelId), inline: true },
        { name: "🛒 Sales channel", value: ch(cfg.salesChannelId), inline: true },
        { name: "⚡ Auto-approve", value: autoText(cfg), inline: true },
        { name: "⭐ Reviews", value: ch(cfg.vouchChannelId), inline: true },
        { name: "🏷️ Customer role", value: cfg.customerRoleId ? `<@&${cfg.customerRoleId}>` : "*not set*", inline: true },
        { name: "🏪 Live store", value: cfg.storeChannelId ? ch(cfg.storeChannelId) : "*not posted* (`/setupstore`)", inline: true },
        { name: "📦 Live stock", value: cfg.liveStockChannelId ? ch(cfg.liveStockChannelId) : "*not posted* (`/livestock`)", inline: true },
        { name: "🏆 Leaderboard", value: cfg.leaderboardChannelId ? ch(cfg.leaderboardChannelId) : "*not posted* (`/setleaderboard`)", inline: true },
        {
          name: "💙 GCash",
          value: config.gcash.number ? `\`${config.gcash.number}\` — ${config.gcash.name || "no name set"}` : "*not set* — add `GCASH_NUMBER` / `GCASH_NAME` to `.env`",
        },
        { name: "🌏 Timezone · Currency", value: `${config.timezone} · ${config.currency}` }
      )
      .setFooter({ text: "Change: /settings store · approval-channel · sales-channel · auto-approve · reviews-channel · customer-role · /setlogchannel" });
    return interaction.editReply({ embeds: [embed] });
  },
};
