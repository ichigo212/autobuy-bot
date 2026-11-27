const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const { success, error } = require("../utils/embeds");
const { bmoney } = require("../utils/format");
const { logEvent } = require("../utils/logger");
const { scheduleRefresh } = require("../utils/liveEmbeds");
const couponSchema = require("../db/models/couponSchema");
const userSchema = require("../db/models/userSchema");

module.exports = {
  name: "redeem",
  category: "Economy",
  description: "Redeem a coupon / gift code for balance",
  hidden: false,
  options: [{ name: "code", description: "The coupon code to redeem", type: ApplicationCommandOptionType.String, required: true, maxLength: 50 }],

  callback: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = interaction.guild.id;
    const code = interaction.options.getString("code").trim().toUpperCase();
    const userId = interaction.user.id;

    const coupon = await couponSchema.findOne({ guildId, code });
    if (!coupon) return interaction.editReply({ embeds: [error(interaction, "That coupon code doesn't exist.")] });
    if (coupon.expiresAt && coupon.expiresAt.getTime() < Date.now()) return interaction.editReply({ embeds: [error(interaction, "That coupon has expired.")] });
    if (coupon.redeemedBy.includes(userId)) return interaction.editReply({ embeds: [error(interaction, "You've already redeemed this coupon.")] });

    // Atomically claim one use (closes the race past maxUses / double redeem).
    const claimed = await couponSchema.findOneAndUpdate(
      { _id: coupon._id, redeemedBy: { $ne: userId }, $expr: { $lt: ["$uses", "$maxUses"] } },
      { $inc: { uses: 1 }, $push: { redeemedBy: userId } },
      { new: true }
    );
    if (!claimed) return interaction.editReply({ embeds: [error(interaction, "This coupon has reached its maximum number of uses.")] });

    let updated;
    try {
      updated = await userSchema.findOneAndUpdate(
        { guildId, userId },
        { $inc: { userBalance: coupon.amount }, $setOnInsert: { guildId, userId } },
        { upsert: true, new: true }
      );
    } catch (err) {
      // Release the use so the user can try again.
      await couponSchema.updateOne({ _id: coupon._id }, { $inc: { uses: -1 }, $pull: { redeemedBy: userId } });
      throw err;
    }

    scheduleRefresh(client, guildId, { store: false, leaderboard: true });
    logEvent(client, guildId, {
      type: "redeem",
      title: "Coupon Redeemed",
      userId,
      fields: [
        { name: "Code", value: `\`${code}\``, inline: true },
        { name: "Amount", value: bmoney(coupon.amount), inline: true },
        { name: "Uses", value: `${claimed.uses}/${claimed.maxUses}`, inline: true },
      ],
    });

    return interaction.editReply({
      embeds: [success(interaction, `Redeemed \`${code}\` for ${bmoney(coupon.amount)}! Your balance is now ${bmoney(updated.userBalance)}.`).setTitle("🎟️ Coupon redeemed")],
    });
  },
};
