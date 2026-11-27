const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const { requireStaff } = require("../utils/permissions");
const { error, baseEmbed, COLORS } = require("../utils/embeds");
const { bmoney } = require("../utils/format");
const { logEvent } = require("../utils/logger");
const { scheduleRefresh } = require("../utils/liveEmbeds");
const fileStock = require("../utils/fileStock");
const { syncStock } = require("../utils/products");
const bus = require("../utils/bus");
const saleSchema = require("../db/models/saleSchema");
const userSchema = require("../db/models/userSchema");

module.exports = {
  name: "refund",
  category: "Staff",
  description: "Refund a purchase (balance back; optionally put the items back in stock)",
  hidden: true,
  options: [
    { name: "user", description: "The user to refund", type: ApplicationCommandOptionType.User, required: true },
    { name: "order", description: "Refund a specific order by its Order ID (e.g. #A1B2C3D4E5F6)", type: ApplicationCommandOptionType.String, required: false },
    { name: "code", description: "Or: their latest purchase of this product code", type: ApplicationCommandOptionType.String, required: false },
    {
      name: "restock",
      description: "Put the delivered items back into stock? Only if they were NOT used. (default: no)",
      type: ApplicationCommandOptionType.Boolean,
      required: false,
    },
    { name: "reason", description: "Why (shown in the staff log)", type: ApplicationCommandOptionType.String, required: false, maxLength: 200 },
  ],

  callback: async (client, interaction) => {
    if (!(await requireStaff(interaction))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = interaction.guild.id;
    const target = interaction.options.getUser("user");
    const productCode = interaction.options.getString("code");
    const orderId = interaction.options.getString("order");
    const restock = interaction.options.getBoolean("restock") ?? false;
    const reason = interaction.options.getString("reason");

    const query = { guildId, userId: target.id, refunded: false };
    if (orderId) {
      const id = orderId.trim().toUpperCase();
      query.orderId = id.startsWith("#") ? id : `#${id}`;
    } else if (productCode) {
      query.productCode = productCode;
    }

    const sale = await saleSchema.findOne(query).sort({ createdAt: -1 });
    if (!sale) {
      const scope = orderId ? ` with order \`${orderId}\`` : productCode ? ` with code \`${productCode}\`` : "";
      return interaction.editReply({ embeds: [error(interaction, `No refundable purchase found for ${target}${scope}.`)] });
    }

    // Mark refunded FIRST, atomically, so a double-click can't refund twice.
    const marked = await saleSchema.findOneAndUpdate(
      { _id: sale._id, refunded: false },
      { $set: { refunded: true, refundedBy: interaction.user.id, refundedAt: new Date(), restocked: restock } },
      { new: true }
    );
    if (!marked) return interaction.editReply({ embeds: [error(interaction, "That purchase was already refunded.")] });

    let updated;
    try {
      updated = await userSchema.findOneAndUpdate(
        { guildId, userId: target.id },
        { $inc: { userBalance: sale.price }, $setOnInsert: { guildId, userId: target.id } },
        { upsert: true, new: true }
      );
    } catch (err) {
      await saleSchema.updateOne({ _id: sale._id }, { $set: { refunded: false, refundedBy: null, refundedAt: null, restocked: false } });
      throw err;
    }

    let stockNote = "Items were **not** put back in stock.";
    if (restock) {
      const codes = sale.deliveredCodes?.length ? sale.deliveredCodes : sale.deliveredCode ? [sale.deliveredCode] : [];
      if (codes.length && fileStock.isValidProductCode(sale.productCode)) {
        await fileStock.restoreCodes(guildId, sale.productCode, codes);
        const left = await syncStock(guildId, sale.productCode);
        stockNote = `**${codes.length}** item(s) returned to stock (now ${left}).`;
        if (left - codes.length === 0) bus.emit("restock", { guildId, productCode: sale.productCode, stock: left });
      } else {
        stockNote = "No stored items to restock.";
      }
    }

    scheduleRefresh(client, guildId, { store: restock, leaderboard: true });
    logEvent(client, guildId, {
      type: "refund",
      title: "Purchase Refunded",
      userId: target.id,
      actorId: interaction.user.id,
      fields: [
        { name: "Order", value: `\`${sale.orderId || "n/a"}\``, inline: true },
        { name: "Product", value: `${sale.productName} (\`${sale.productCode}\`)`, inline: true },
        { name: "Refunded", value: bmoney(sale.price), inline: true },
        { name: "Stock", value: stockNote },
        ...(reason ? [{ name: "Reason", value: reason }] : []),
      ],
    });

    target
      .send({
        embeds: [
          baseEmbed(interaction)
            .setColor(COLORS.warning)
            .setTitle("↩️ You were refunded")
            .setDescription(`Your order \`${sale.orderId}\` (**${sale.productName}**) in **${interaction.guild.name}** was refunded. ${bmoney(sale.price)} is back in your balance.${reason ? `\n> ${reason}` : ""}`),
        ],
      })
      .catch(() => {});

    const embed = baseEmbed(interaction)
      .setColor(COLORS.warning)
      .setTitle("↩️ Refund complete")
      .addFields(
        { name: "Order", value: `\`${sale.orderId || "n/a"}\``, inline: true },
        { name: "User", value: `${target}`, inline: true },
        { name: "Product", value: sale.productName, inline: true },
        { name: "Amount", value: bmoney(sale.price), inline: true },
        { name: "New balance", value: bmoney(updated.userBalance), inline: true },
        { name: "Stock", value: stockNote }
      );
    return interaction.editReply({ embeds: [embed] });
  },
};
