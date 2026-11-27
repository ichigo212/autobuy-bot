const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const { requireStaff } = require("../utils/permissions");
const { baseEmbed, success, error, groupProducts, byCode } = require("../utils/embeds");
const { updateProduct } = require("../utils/products");
const { scheduleRefresh } = require("../utils/liveEmbeds");
const storeSchema = require("../db/models/storeSchema");

// /category — name the groups products are shown in on the store and live stock.
// Without a category, products are grouped automatically by name
// ("2x 1 Month Boost", "4x 1 Month Boost" → "1 Month Boost").

// "1-7", "1,2,3", "1-3, 8" or "all" → the matching product codes (in code order).
const pickCodes = (raw, products) => {
  const all = products.map((p) => String(p.productCode)).sort((a, b) => byCode({ productCode: a }, { productCode: b }));
  const text = String(raw || "").trim();
  if (/^all$/i.test(text)) return { codes: all, unknown: [] };
  const want = new Set();
  const unknown = [];
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const [lo, hi] = [Number(range[1]), Number(range[2])].sort((a, b) => a - b);
      const hits = all.filter((c) => /^\d+$/.test(c) && Number(c) >= lo && Number(c) <= hi);
      if (!hits.length) unknown.push(part);
      hits.forEach((c) => want.add(c));
    } else if (all.includes(part)) want.add(part);
    else unknown.push(part);
  }
  return { codes: all.filter((c) => want.has(c)), unknown };
};

const codesOption = { name: "codes", description: 'Product codes: "1-7", "1,2,3", "1-3, 8" or "all"', type: ApplicationCommandOptionType.String, required: true };

module.exports = {
  name: "category",
  category: "Staff",
  description: "Group products on the store (e.g. 1 Month / 3 Months)",
  hidden: true,
  options: [
    {
      name: "set",
      description: "Put products in a group",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        { name: "name", description: "Group name, e.g. 1 Month Server Boost", type: ApplicationCommandOptionType.String, required: true, maxLength: 60 },
        codesOption,
      ],
    },
    {
      name: "clear",
      description: "Take products out of their group (they're grouped by name again)",
      type: ApplicationCommandOptionType.Subcommand,
      options: [codesOption],
    },
    { name: "list", description: "Show the groups as buyers see them", type: ApplicationCommandOptionType.Subcommand },
  ],

  callback: async (client, interaction) => {
    if (!(await requireStaff(interaction))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = interaction.guild.id;
    const sub = interaction.options.getSubcommand();
    const products = (await storeSchema.findOne({ guildId }))?.store || [];
    if (!products.length) return interaction.editReply({ embeds: [error(interaction, "No products in the store yet.")] });

    if (sub === "list") {
      const embed = baseEmbed(interaction).setTitle("🗂️ Product groups");
      const lines = groupProducts(products).map((g) => {
        const codes = g.products.map((p) => `\`${p.productCode}\``).join(" ");
        const named = g.products.some((p) => p.category);
        return `**${g.name || "Products"}**${named ? "" : " *(auto)*"}\n${codes}`;
      });
      embed.setDescription(`${lines.join("\n\n")}\n\n-# *(auto)* = grouped by name. Rename with \`/category set\`.`.slice(0, 4096));
      return interaction.editReply({ embeds: [embed] });
    }

    const { codes, unknown } = pickCodes(interaction.options.getString("codes"), products);
    if (!codes.length) return interaction.editReply({ embeds: [error(interaction, `No products match \`${interaction.options.getString("codes")}\`.`)] });

    const name = sub === "set" ? interaction.options.getString("name").trim() : null;
    for (const code of codes) await updateProduct({ guildId, productCode: code, updates: { category: name } });
    scheduleRefresh(client, guildId);

    const list = codes.map((c) => `\`${c}\``).join(" ");
    const warn = unknown.length ? `\n⚠️ Not found: ${unknown.map((u) => `\`${u}\``).join(" ")}` : "";
    return interaction.editReply({
      embeds: [
        success(interaction, name ? `${codes.length} product(s) are now in **${name}**: ${list}${warn}` : `${codes.length} product(s) are grouped by name again: ${list}${warn}`),
      ],
    });
  },
};
