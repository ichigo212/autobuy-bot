const { AttachmentBuilder, MessageFlags } = require("discord.js");
const crypto = require("crypto");
const config = require("../config");
const { buildReceiptEmbed, getStock } = require("./embeds");
const { money } = require("./format");
const { buildDeliveryComponents, scheduleRefresh } = require("./liveEmbeds");
const fileStock = require("./fileStock");
const { syncStock } = require("./products");
const { logEvent } = require("./logger");
const { postSale } = require("./salesFeed");
const { getStoreStatus, closedText, grantCustomerRole, reviewButtonRow, reviewsEnabled } = require("./features");

const userSchema = require("../db/models/userSchema");
const storeSchema = require("../db/models/storeSchema");
const saleSchema = require("../db/models/saleSchema");

const MAX_QUANTITY = 25;

// Order id like "#7F3A9C21B04E" — 48 random bits, so collisions are practically
// impossible (and the sale schema enforces uniqueness anyway).
const generateOrderId = () => `#${crypto.randomBytes(6).toString("hex").toUpperCase()}`;

const buildInvoiceText = ({ orderId, product, quantity, unitPrice, total, codes, guildName }) =>
  [
    `${config.brand} — Invoice`,
    guildName ? `Server:   ${guildName}` : null,
    `Order ID: ${orderId}`,
    `Date:     ${new Date().toISOString()}`,
    `Product:  ${product.productName} (${product.productCode})`,
    `Quantity: ${quantity}`,
    `Price:    ${money(unitPrice)} each  •  Total: ${money(total)}`,
    "",
    "Your item(s):",
    "------------------------------",
    ...codes.map((c, i) => `${i + 1}. ${c}`),
    "------------------------------",
    "",
    "Thank you for your purchase! Keep this file and your Order ID for support.",
  ]
    .filter((l) => l !== null)
    .join("\n");

// Post a staff alert when a product runs low or sells out (best-effort).
const maybeAlertLowStock = async (client, guildId, product, before, after) => {
  const t = config.lowStockThreshold;
  if (after === 0 && before > 0) {
    await logEvent(client, guildId, {
      type: "stock",
      title: "Sold Out",
      description: `**${product.productName}** (\`${product.productCode}\`) just sold out. Restock with \`/updatestocknew\`.`,
    });
  } else if (after > 0 && after <= t && before > t) {
    await logEvent(client, guildId, {
      type: "stock",
      title: "Low Stock",
      description: `**${product.productName}** (\`${product.productCode}\`) is down to **${after}** item(s).`,
    });
  }
};

// Central purchase routine shared by every buy flow (store menu, shops, live
// stock board, /stock buy).
//
// Guarantees:
//   • The balance is debited atomically and only if it covers the total.
//   • The buyer is only ever charged for items actually taken from stock; any
//     shortfall (a concurrent buyer won the race) is refunded.
//   • If anything throws after the debit, the charge is refunded and any items
//     already taken are put back — a buyer is never charged for nothing.
//   • Items are recorded on the sale BEFORE the DM, so staff can always re-send.
const purchaseProduct = async ({ client, guildId, userId, productCode, quantity = 1, guildName }) => {
  quantity = Math.max(1, Math.min(MAX_QUANTITY, Math.floor(Number(quantity) || 1)));

  const status = await getStoreStatus(guildId);
  if (!status.open) return { ok: false, message: closedText(status) };

  const storeData = await storeSchema.findOne({ guildId });
  const product = storeData?.store.find((p) => p.productCode === productCode);
  if (!product) return { ok: false, message: "That product doesn't exist (anymore). Check `/store`." };

  const unitPrice = Math.max(0, Number(product.productPrice) || 0);
  const stockBefore = await fileStock.countCodes(guildId, productCode);
  if (stockBefore <= 0) return { ok: false, message: `**${product.productName}** is sold out.` };
  if (stockBefore < quantity) {
    return { ok: false, message: `Only **${stockBefore}** of **${product.productName}** left — you asked for **${quantity}**.` };
  }

  const total = unitPrice * quantity;

  // Make sure the buyer has an account row (so free items work for new users).
  await userSchema.findOneAndUpdate({ guildId, userId }, { $setOnInsert: { guildId, userId, userBalance: 0 } }, { upsert: true });

  // Atomic conditional debit.
  const debited = await userSchema.findOneAndUpdate(
    { guildId, userId, userBalance: { $gte: total } },
    { $inc: { userBalance: -total } },
    { new: true }
  );
  if (!debited) {
    const balance = Number((await userSchema.findOne({ guildId, userId }))?.userBalance) || 0;
    return {
      ok: false,
      message: `You need **${money(Math.max(total - balance, 0))}** more to buy **${quantity}× ${product.productName}** (total ${money(total)}, you have ${money(balance)}). Use \`/topup\` to add balance.`,
    };
  }

  // Tracks how much of `total` has been given back, so a rollback refunds
  // exactly what is still debited — never more, never less.
  let refunded = 0;
  const refund = async (amount) => {
    if (amount > 0) {
      await userSchema.updateOne({ guildId, userId }, { $inc: { userBalance: amount } });
      refunded += amount;
    }
  };

  let taken = [];
  let saleRecorded = false;
  const orderId = generateOrderId();

  try {
    taken = await fileStock.popCodes(guildId, productCode, quantity);
    if (taken.length === 0) {
      await refund(total);
      return { ok: false, message: `**${product.productName}** just sold out. You were not charged.` };
    }

    const filled = taken.length;
    const charged = filled * unitPrice;
    if (filled < quantity) await refund((quantity - filled) * unitPrice);
    const newBalance = debited.userBalance + (total - charged);

    const remaining = await syncStock(guildId, productCode);

    // Record the sale (with the items) before delivering.
    // Snapshot cost & profit at sale time (profit = price − what the item cost you).
    const costPerUnit = product.cost != null && Number.isFinite(Number(product.cost)) ? Number(product.cost) : null;
    const profitPerUnit = costPerUnit != null ? unitPrice - costPerUnit : null;
    await saleSchema.create({
      guildId,
      userId,
      orderId,
      productCode,
      productName: product.productName,
      price: charged,
      unitPrice,
      quantity: filled,
      costPerUnit,
      profitPerUnit,
      deliveryType: "code",
      deliveredCode: taken[0],
      deliveredCodes: taken,
      delivered: false,
    });
    saleRecorded = true;

    // ---- Point of no return: the sale is committed. Delivery is best-effort. ----

    let dmOk = false;
    try {
      const user = await client.users.fetch(userId);
      const payload = {
        embeds: [buildReceiptEmbed(null, { product, price: charged, quantity: filled, newBalance, codes: taken, orderId })],
        files: [
          new AttachmentBuilder(
            Buffer.from(buildInvoiceText({ orderId, product, quantity: filled, unitPrice, total: charged, codes: taken, guildName }), "utf8"),
            { name: `invoice-${orderId.slice(1)}.txt` }
          ),
        ],
        components: buildDeliveryComponents({ orderId, buttons: Array.isArray(product.deliveryButtons) ? product.deliveryButtons : [] }),
      };
      if (await reviewsEnabled(guildId).catch(() => false)) payload.components.push(reviewButtonRow(orderId));
      if (product.deliveryMessage) payload.content = String(product.deliveryMessage).slice(0, 2000);
      await user.send(payload);
      dmOk = true;
    } catch {
      dmOk = false;
    }
    if (dmOk) saleSchema.updateOne({ orderId }, { $set: { delivered: true } }).catch(() => {});

    scheduleRefresh(client, guildId, { leaderboard: true });

    // Staff log + stock alerts (fire-and-forget; never delays the buyer).
    (async () => {
      const fields = [
        { name: "Order", value: `\`${orderId}\``, inline: true },
        { name: "Product", value: `${product.emoji ? `${product.emoji} ` : ""}${product.productName} (\`${productCode}\`)`, inline: true },
        { name: "Qty", value: `×${filled}`, inline: true },
        { name: "Charged", value: `**${money(charged)}**`, inline: true },
        { name: "Stock left", value: `${remaining}`, inline: true },
        { name: "Delivery", value: dmOk ? "✅ DM sent" : "⚠️ DM failed — shown in channel", inline: true },
      ];
      if (profitPerUnit != null) fields.push({ name: "💹 Profit", value: `**${money(profitPerUnit * filled)}**`, inline: true });
      await postSale(client, guildId, {
        userId,
        orderId,
        product,
        quantity: filled,
        charged,
        profit: profitPerUnit != null ? profitPerUnit * filled : null,
        newBalance,
        remaining,
        delivered: dmOk,
      });
      await logEvent(client, guildId, { type: "sale", title: "New Sale", userId, fields });
      await maybeAlertLowStock(client, guildId, product, stockBefore, remaining);
      await grantCustomerRole(client, guildId, userId);
    })().catch(() => {});

    return {
      ok: true,
      dm: dmOk,
      orderId,
      quantity: filled,
      product: { ...product, productStock: remaining },
      newBalance,
      charged,
      codes: taken,
      shortfall: quantity - filled,
      message:
        `Order \`${orderId}\` — **${filled}× ${product.productName}** for **${money(charged)}**. Balance left: **${money(newBalance)}**.` +
        (filled < quantity ? `\n↩️ Only ${filled} were left, so ${money((quantity - filled) * unitPrice)} was refunded.` : ""),
    };
  } catch (err) {
    console.error("Purchase failed after debit — rolling back:", err);
    if (!saleRecorded) {
      if (taken.length) {
        await fileStock.restoreCodes(guildId, productCode, taken).catch((e) => console.error("Restore failed:", e));
        await syncStock(guildId, productCode).catch(() => {});
      }
      await refund(total - refunded).catch((e) =>
        console.error("Refund failed — manual fix needed:", { guildId, userId, amount: total - refunded }, e)
      );
      return { ok: false, message: "Something went wrong with that purchase. You were **not** charged — please try again." };
    }
    // Sale already recorded: the buyer owns those items; just report it.
    return { ok: false, message: `Your order \`${orderId}\` was recorded but something failed afterwards. Use \`/orderid ${orderId}\` or contact staff.` };
  }
};

// Shared reply for every purchase flow. Always ephemeral. When the DM failed,
// the items are shown right here so a paid order is never lost.
const replyWithPurchase = async (interaction, result) => {
  if (!result.ok) return interaction.editReply({ content: `❌ ${result.message}`, embeds: [], components: [] });

  if (result.dm) {
    return interaction.editReply({ content: `✅ ${result.message}\n📬 Check your DMs for your item(s) and invoice.`, embeds: [], components: [] });
  }
  const embed = buildReceiptEmbed(interaction, {
    product: result.product,
    price: result.charged,
    quantity: result.quantity,
    newBalance: result.newBalance,
    codes: result.codes,
    orderId: result.orderId,
  });
  return interaction.editReply({
    content: `✅ ${result.message}\n⚠️ I couldn't DM you (your DMs are closed), so here are your item(s). **Save them now.** You can also get them later with \`/orderid ${result.orderId}\`.`,
    embeds: [embed],
    components: buildDeliveryComponents({ orderId: result.orderId }),
  });
};

module.exports = { purchaseProduct, replyWithPurchase, generateOrderId, MAX_QUANTITY, getStock };
