const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const { requireStaff } = require("../utils/permissions");
const { baseEmbed, success, error } = require("../utils/embeds");
const { bmoney, ts } = require("../utils/format");
const { logEvent } = require("../utils/logger");
const couponSchema = require("../db/models/couponSchema");

// /coupons list | delete — manage coupons created with /createcoupon.
module.exports = {
  name: "coupons",
  category: "Staff",
  description: "List or delete coupon codes",
  hidden: true,
  options: [
    { name: "list", description: "Show every coupon and how often it was used", type: ApplicationCommandOptionType.Subcommand },
    {
      name: "delete",
      description: "Delete a coupon so it can't be redeemed anymore",
      type: ApplicationCommandOptionType.Subcommand,
      options: [{ name: "code", description: "The coupon code", type: ApplicationCommandOptionType.String, required: true }],
    },
  ],

  callback: async (client, interaction) => {
    if (!(await requireStaff(interaction))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guild.id;

    if (interaction.options.getSubcommand() === "delete") {
      const code = interaction.options.getString("code").trim().toUpperCase();
      const removed = await couponSchema.findOneAndDelete({ guildId, code });
      if (!removed) return interaction.editReply({ embeds: [error(interaction, `No coupon \`${code}\` found.`)] });
      logEvent(client, guildId, { type: "admin", title: "Coupon Deleted", actorId: interaction.user.id, description: `\`${code}\` (${removed.uses}/${removed.maxUses} used)` });
      return interaction.editReply({ embeds: [success(interaction, `Deleted coupon \`${code}\`.`)] });
    }

    const coupons = await couponSchema.find({ guildId }).sort({ createdAt: -1 }).limit(50).lean();
    const embed = baseEmbed(interaction).setTitle("🎟️ Coupons");
    if (!coupons.length) return interaction.editReply({ embeds: [embed.setDescription("No coupons yet. Create one with `/createcoupon`.")] });

    const now = Date.now();
    const lines = coupons.map((c) => {
      const expired = c.expiresAt && new Date(c.expiresAt).getTime() < now;
      const usedUp = c.uses >= c.maxUses;
      const state = expired ? "⌛ expired" : usedUp ? "🔒 used up" : "🟢 active";
      const exp = c.expiresAt ? ` · expires ${ts(c.expiresAt)}` : "";
      return `\`${c.code}\` — ${bmoney(c.amount)} · ${c.uses}/${c.maxUses} used · ${state}${exp}`;
    });
    return interaction.editReply({ embeds: [embed.setDescription(lines.join("\n").slice(0, 4096))] });
  },
};
