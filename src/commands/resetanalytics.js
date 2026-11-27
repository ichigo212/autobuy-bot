const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const config = require("../config");
const { requireStaff } = require("../utils/permissions");
const { success, error, baseEmbed } = require("../utils/embeds");
const saleSchema = require("../db/models/saleSchema");
const guildConfigSchema = require("../db/models/guildConfigSchema");

// /resetanalytics — zero out the profit/revenue figures reported by /analytics.
//
// This is NON-DESTRUCTIVE. It never deletes sale documents (refunds and order
// lookups still depend on them). Instead it records a per-guild
// `analyticsResetAt` timestamp; /analytics only counts sales at or after that
// point, so the reported totals start fresh from "now".
//
//   /resetanalytics reset  → set the reset point to now (fresh totals)
//   /resetanalytics undo   → clear the reset point (restore full history)
//   /resetanalytics status → show the current reset point + what's hidden
module.exports = {
  name: "resetanalytics",
  category: "Staff",
  description: "Reset the profit/revenue totals shown in /analytics (non-destructive)",
  hidden: true,
  options: [
    {
      name: "reset",
      description: "Start analytics totals fresh from now (keeps sale history intact)",
      type: ApplicationCommandOptionType.Subcommand,
    },
    {
      name: "undo",
      description: "Restore the full analytics history (clears the reset point)",
      type: ApplicationCommandOptionType.Subcommand,
    },
    {
      name: "status",
      description: "Show the current analytics reset point",
      type: ApplicationCommandOptionType.Subcommand,
    },
  ],

  callback: async (client, interaction) => {
    if (!(await requireStaff(interaction))) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (sub === "reset") {
      const now = new Date();

      // Count what's about to be hidden so staff can see the impact.
      const hidden = await saleSchema.countDocuments({
        guildId,
        refunded: false,
        createdAt: { $lt: now },
      });

      await guildConfigSchema.findOneAndUpdate(
        { guildId },
        { $set: { analyticsResetAt: now }, $setOnInsert: { guildId } },
        { upsert: true }
      );

      const embed = success(
        interaction,
        `Analytics have been reset. \`/analytics\` now counts sales from <t:${Math.floor(
          now.getTime() / 1000
        )}:f> onward.`
      ).addFields(
        {
          name: "What this did",
          value: [
            `• Reset point set to now.`,
            `• **${hidden.toLocaleString()}** earlier sale(s) are now hidden from the report.`,
            `• No sale history was deleted — refunds and order lookups still work.`,
          ].join("\n"),
        },
        {
          name: "Undo",
          value: "Run `/resetanalytics undo` to restore the full history.",
        }
      );

      return interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (sub === "undo") {
      const existing = await guildConfigSchema.findOne({ guildId });
      if (!existing?.analyticsResetAt) {
        return interaction.followUp({
          embeds: [error(interaction, "Analytics aren't reset — nothing to undo. The full history is already showing.")],
          flags: MessageFlags.Ephemeral,
        });
      }

      await guildConfigSchema.findOneAndUpdate(
        { guildId },
        { $set: { analyticsResetAt: null } },
        { upsert: true }
      );

      return interaction.followUp({
        embeds: [success(interaction, "Analytics reset cleared. `/analytics` now shows the full sales history again.")],
        flags: MessageFlags.Ephemeral,
      });
    }

    // status
    const cfg = await guildConfigSchema.findOne({ guildId });
    const resetAt = cfg?.analyticsResetAt || null;

    const embed = baseEmbed(interaction).setTitle("♻️ Analytics Reset Status");

    if (!resetAt) {
      embed.setDescription(
        "Analytics are **not** reset. `/analytics` is reporting the full sales history.\n\nRun `/resetanalytics reset` to start the totals fresh from now."
      );
      return interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    const ts = Math.floor(resetAt.getTime() / 1000);
    const [hiddenCount, countedCount] = await Promise.all([
      saleSchema.countDocuments({ guildId, refunded: false, createdAt: { $lt: resetAt } }),
      saleSchema.countDocuments({ guildId, refunded: false, createdAt: { $gte: resetAt } }),
    ]);

    embed.setDescription(
      [
        `Analytics are reset. Only sales from <t:${ts}:f> (<t:${ts}:R>) onward are counted.`,
        ``,
        `• Counted in reports: **${countedCount.toLocaleString()}** sale(s)`,
        `• Hidden by the reset: **${hiddenCount.toLocaleString()}** sale(s)`,
        ``,
        `Run \`/resetanalytics undo\` to restore the full history.`,
      ].join("\n")
    );

    return interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
