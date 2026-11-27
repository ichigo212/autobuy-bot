const { ApplicationCommandOptionType, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require("discord.js");
const { baseEmbed } = require("../utils/embeds");
const { bmoney, ts } = require("../utils/format");
const { isStaff } = require("../utils/permissions");
const userSchema = require("../db/models/userSchema");
const saleSchema = require("../db/models/saleSchema");

// /user [target] — account card: balance + purchase stats. Viewing your OWN
// account offers a "Generate recovery key" button.
module.exports = {
  name: "user",
  category: "Economy",
  description: "View an account (balance & stats) and manage your recovery key",
  hidden: false,
  options: [{ name: "target", description: "The user to look up (defaults to you)", type: ApplicationCommandOptionType.User, required: false }],

  callback: async (client, interaction) => {
    const target = interaction.options.getUser("target") || interaction.user;
    const isSelf = target.id === interaction.user.id;
    const guildId = interaction.guild.id;

    const [userData, sales] = await Promise.all([
      isSelf
        ? userSchema.findOneAndUpdate({ guildId, userId: target.id }, { $setOnInsert: { guildId, userId: target.id, userBalance: 0 } }, { upsert: true, new: true })
        : userSchema.findOne({ guildId, userId: target.id }),
      saleSchema.find({ guildId, userId: target.id, refunded: false }).sort({ createdAt: -1 }).lean(),
    ]);

    const spent = sales.reduce((s, x) => s + (x.price || 0), 0);
    const items = sales.reduce((s, x) => s + (x.quantity || 1), 0);
    const showStats = isSelf || isStaff(interaction);

    const embed = baseEmbed(interaction)
      .setAuthor({ name: target.username, iconURL: target.displayAvatarURL() })
      .setThumbnail(target.displayAvatarURL({ size: 256 }))
      .setTitle(isSelf ? "👤 Your account" : "👤 Account")
      .addFields({ name: "👛 Balance", value: bmoney(userData?.userBalance ?? 0), inline: true });

    if (showStats) {
      embed.addFields(
        { name: "🛒 Orders", value: `${sales.length}`, inline: true },
        { name: "📦 Items bought", value: `${items}`, inline: true },
        { name: "💸 Total spent", value: bmoney(spent), inline: true },
        { name: "🕒 Last order", value: sales[0] ? `${sales[0].productName} ${ts(sales[0].createdAt)}` : "—", inline: true }
      );
    }

    const components = [];
    if (isSelf) {
      embed.setFooter({ text: "Tip: protect your balance with a recovery key ↓" });
      components.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("user:reckey").setLabel("Generate recovery key").setEmoji("🔐").setStyle(ButtonStyle.Secondary)
        )
      );
    }

    return interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral });
  },
};
