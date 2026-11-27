const { AttachmentBuilder, MessageFlags } = require("discord.js");
const fs = require("fs/promises");
const path = require("path");
const { requireOwner } = require("../utils/permissions");
const { success, error } = require("../utils/embeds");
const fileStock = require("../utils/fileStock");
const { getCollection } = require("../db/fileStore");
const storeSchema = require("../db/models/storeSchema");
const saleSchema = require("../db/models/saleSchema");
const couponSchema = require("../db/models/couponSchema");
const guildConfigSchema = require("../db/models/guildConfigSchema");

const BACKUP_DIR = path.join(__dirname, "..", "..", "backups");
const MAX_ATTACH = 8 * 1024 * 1024;

// /backup — export everything this server has (products, stock items, balances,
// sales, coupons, settings) as one JSON file. Saved to the backups/ folder AND
// sent to you privately. Owner only (it contains stock items and balances).
module.exports = {
  name: "backup",
  category: "Admin",
  description: "(Owner) Export all of this server's bot data to a JSON backup",
  hidden: true,

  callback: async (client, interaction) => {
    if (!(await requireOwner(interaction))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = interaction.guild.id;
    const [store, sales, coupons, config] = await Promise.all([
      storeSchema.findOne({ guildId }).lean(),
      saleSchema.find({ guildId }).lean(),
      couponSchema.find({ guildId }).lean(),
      guildConfigSchema.findOne({ guildId }).lean(),
    ]);

    const stock = {};
    for (const p of store?.store || []) stock[p.productCode] = await fileStock.readCodes(guildId, p.productCode);

    const fileData = {};
    for (const name of ["user-data", "recovery-key-data", "topup-requests", "sticky-messages"]) {
      fileData[name] = await getCollection(name).find({ guildId });
    }

    const data = {
      exportedAt: new Date().toISOString(),
      guildId,
      guildName: interaction.guild.name,
      store,
      stock,
      sales,
      coupons,
      config,
      ...fileData,
    };
    const json = JSON.stringify(data, null, 2);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `backup-${guildId}-${stamp}.json`;

    await fs.mkdir(BACKUP_DIR, { recursive: true });
    await fs.writeFile(path.join(BACKUP_DIR, fileName), json, "utf8");

    const summary = `Backup saved to \`backups/${fileName}\` — ${(store?.store || []).length} products, ${sales.length} sales, ${fileData["user-data"].length} balances, ${coupons.length} coupons.`;
    if (Buffer.byteLength(json) > MAX_ATTACH) {
      return interaction.editReply({ embeds: [success(interaction, `${summary}\n(Too big to attach here — grab it from the bot's folder.)`)] });
    }
    try {
      return await interaction.editReply({
        embeds: [success(interaction, `${summary}\n🔒 Keep this file private — it contains stock items and balances.`)],
        files: [new AttachmentBuilder(Buffer.from(json, "utf8"), { name: fileName })],
      });
    } catch {
      return interaction.editReply({ embeds: [error(interaction, `${summary}\nCouldn't attach the file here, but it's saved on disk.`)] });
    }
  },
};
