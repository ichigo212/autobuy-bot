const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const config = require("../config");
const { requireStaff } = require("../utils/permissions");
const { success, error, baseEmbed } = require("../utils/embeds");
const couponSchema = require("../db/models/couponSchema");

module.exports = {
  name: "createcoupon",
  category: "Staff",
  description: "Create a redeemable balance coupon / gift code",
  hidden: true,
  options: [
    {
      name: "code",
      description: "The coupon code users will redeem (e.g. WELCOME10)",
      type: ApplicationCommandOptionType.String,
      required: true,
    },
    {
      name: "amount",
      description: "Balance granted per redemption",
      type: ApplicationCommandOptionType.Integer,
      required: true,
      minValue: 1,
    },
    {
      name: "uses",
      description: "How many times it can be redeemed in total (default 1)",
      type: ApplicationCommandOptionType.Integer,
      required: false,
      minValue: 1,
    },
    {
      name: "expires-in-days",
      description: "Days until it expires (default: never)",
      type: ApplicationCommandOptionType.Integer,
      required: false,
      minValue: 1,
    },
  ],

  callback: async (client, interaction) => {
    if (!(await requireStaff(interaction))) return;

    const code = interaction.options.getString("code").trim().toUpperCase();
    const amount = interaction.options.getInteger("amount");
    const maxUses = interaction.options.getInteger("uses") || 1;
    const days = interaction.options.getInteger("expires-in-days");

    // Compute expiry from `days` (stamped now; safe outside a workflow context).
    const expiresAt = days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;

    // Reject duplicate codes in this guild.
    const existing = await couponSchema.findOne({ guildId: interaction.guild.id, code });
    if (existing) {
      return interaction.reply({
        embeds: [error(interaction, `A coupon with code \`${code}\` already exists.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
      return interaction.reply({ embeds: [error(interaction, "Coupon codes must be 3–32 letters, numbers, `-` or `_`.")], flags: MessageFlags.Ephemeral });
    }

    await couponSchema.create({
      guildId: interaction.guild.id,
      code,
      amount,
      maxUses,
      expiresAt,
      createdBy: interaction.user.id,
    });

    const embed = baseEmbed(interaction)
      .setColor("Green")
      .setTitle("🎟️ Coupon Created")
      .addFields(
        { name: "Code", value: `\`${code}\``, inline: true },
        { name: "Amount", value: `${amount} ${config.currency}`, inline: true },
        { name: "Max uses", value: `${maxUses}`, inline: true },
        { name: "Expires", value: expiresAt ? `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>` : "Never", inline: true }
      )
      .setDescription(`Users can claim it with \`/redeem ${code}\`.`);

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
