const { EmbedBuilder } = require("discord.js");
const config = require("../config");
const { COLORS } = require("./embeds");
const { money, bmoney, clip } = require("./format");
const guildConfigSchema = require("../db/models/guildConfigSchema");

// Posts a notification for every sale to the owner's private sales channel
// (/settings sales-channel). Best-effort: never throws, never delays a purchase.
async function postSale(client, guildId, { userId, orderId, product, quantity, charged, profit, newBalance, remaining, delivered }) {
  try {
    const cfg = await guildConfigSchema.findOne({ guildId });
    if (!cfg?.salesChannelId) return false;
    const channel = await client.channels.fetch(cfg.salesChannelId).catch(() => null);
    if (!channel?.isTextBased?.()) return false;

    const user = await client.users.fetch(userId).catch(() => null);
    const embed = new EmbedBuilder()
      .setColor(COLORS.success)
      .setAuthor({ name: user ? `${user.username} bought something` : "New sale", iconURL: user?.displayAvatarURL?.() || undefined })
      .setTitle(`🛒 ${clip(`${product.emoji ? `${product.emoji} ` : ""}${product.productName}`, 200)} ×${quantity}`)
      .addFields(
        { name: "👤 Buyer", value: `<@${userId}>`, inline: true },
        { name: "💵 Total", value: bmoney(charged), inline: true },
        { name: "💹 Profit", value: profit != null ? bmoney(profit) : "*set a cost with `/setcost`*", inline: true },
        { name: "📦 Stock left", value: `${remaining}`, inline: true },
        { name: "👛 Buyer's balance", value: money(newBalance), inline: true },
        { name: "🆔 Order", value: `\`${orderId}\``, inline: true }
      )
      .setFooter({ text: `${config.brand} • ${delivered ? "Delivered by DM" : "⚠️ DM failed: shown in channel"}` })
      .setTimestamp();
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return true;
  } catch (err) {
    console.error("Sales notification failed:", err.message);
    return false;
  }
}

module.exports = { postSale };
