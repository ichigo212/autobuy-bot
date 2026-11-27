const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ApplicationCommandOptionType,
  MessageFlags,
} = require("discord.js");
const config = require("../config");
const { isOwner, isStaff } = require("../utils/permissions");
const { baseEmbed } = require("../utils/embeds");
const { bmoney, clip } = require("../utils/format");
const userSchema = require("../db/models/userSchema");
const guildConfigSchema = require("../db/models/guildConfigSchema");

// ---------------------------------------------------------------------------
// /help — a home page plus one page per section, switched with a dropdown.
// People only see the sections they can use (buyer / staff / owner).
// Pages are built from the loaded commands, so new commands and subcommands
// show up automatically; anything not listed in SECTIONS lands in "More".
// ---------------------------------------------------------------------------

const LEVEL = { user: 0, staff: 1, owner: 2 };

const SECTIONS = [
  { key: "shop", emoji: "🛒", name: "Shopping", level: "user", blurb: "Browse the store, buy, and find your orders.", commands: ["store", "stock", "orderid", "history", "leaderboard"] },
  { key: "wallet", emoji: "💰", name: "Wallet", level: "user", blurb: "Top up with GCash and manage your balance.", commands: ["topup", "balance", "gift", "redeem", "recoverbalance", "user"] },
  {
    key: "products",
    emoji: "🛠️",
    name: "Products & Stock",
    level: "staff",
    blurb: "Add products, restock, and post the live store.",
    commands: ["addproduct", "updateproduct", "removeproduct", "category", "changestock", "editstock", "updatestocknew", "editdelivery", "setcost", "setupstore", "createshop", "livestock"],
  },
  { key: "sales", emoji: "📊", name: "Sales & Money", level: "staff", blurb: "Profit, refunds, balances and coupons.", commands: ["analytics", "expense", "refund", "addbalance", "createcoupon", "coupons", "resetanalytics"] },
  { key: "tools", emoji: "🧰", name: "Staff Tools", level: "staff", blurb: "Custom embeds and sticky messages.", commands: ["embed", "stickmessage"] },
  {
    key: "settings",
    emoji: "👑",
    name: "Settings & Channels",
    level: "owner",
    blurb: "Store switch, GCash auto-approve, and where everything gets posted.",
    commands: ["settings", "setlogchannel", "settopupchannel", "setleaderboard", "removebalance", "backup"],
  },
  { key: "admins", emoji: "📢", name: "Announcements & Admins", level: "owner", blurb: "Message everyone and choose who runs the bot.", commands: ["announcement"] },
];

const accessOf = (interaction) => (isOwner(interaction) ? "owner" : isStaff(interaction) ? "staff" : "user");

// Level needed for a command that isn't in SECTIONS (best guess from its flags).
const guessLevel = (cmd) => (cmd.category === "Admin" ? "owner" : cmd.hidden ? "staff" : "user");

// Sections this person can open, with "More" for unlisted commands.
const sectionsFor = (client, access) => {
  const listed = new Set(SECTIONS.flatMap((s) => s.commands));
  const extra = [...client.commands.values()].filter((c) => c.name !== "help" && !listed.has(c.name) && LEVEL[guessLevel(c)] <= LEVEL[access]);
  const out = SECTIONS.filter((s) => LEVEL[s.level] <= LEVEL[access])
    .map((s) => ({ ...s, cmds: s.commands.map((n) => client.commands.get(n)).filter(Boolean) }))
    .filter((s) => s.cmds.length);
  if (extra.length) out.push({ key: "more", emoji: "🧩", name: "More", level: "user", blurb: "Other commands.", cmds: extra });
  return out;
};

// "`<amount>` `[channel]`" for a command's (or subcommand's) options.
const usage = (options = []) =>
  options
    .filter((o) => o.type !== ApplicationCommandOptionType.Subcommand && o.type !== ApplicationCommandOptionType.SubcommandGroup)
    .map((o) => `\`${o.required ? `<${o.name}>` : `[${o.name}]`}\``)
    .join(" ");

// One entry per command, or per subcommand when it has them.
const entries = (cmd) => {
  const subs = (cmd.options || []).filter((o) => o.type === ApplicationCommandOptionType.Subcommand);
  const groups = (cmd.options || []).filter((o) => o.type === ApplicationCommandOptionType.SubcommandGroup);
  if (!subs.length && !groups.length) return [{ name: `/${cmd.name}`, args: usage(cmd.options), desc: cmd.description }];
  const out = subs.map((s) => ({ name: `/${cmd.name} ${s.name}`, args: usage(s.options), desc: s.description }));
  for (const g of groups) for (const s of g.options || []) out.push({ name: `/${cmd.name} ${g.name} ${s.name}`, args: usage(s.options), desc: s.description });
  return out;
};

const cleanDesc = (d) => String(d || "").replace(/^\((Owner|Staff)\)\s*/i, "");

// Discord limits a description to 4096 chars; long sections spill into fields.
const fillBody = (embed, lines) => {
  let desc = "";
  let i = 0;
  for (; i < lines.length; i++) {
    if (desc.length + lines[i].length + 2 > 3900) break;
    desc += (desc ? "\n\n" : "") + lines[i];
  }
  embed.setDescription(desc);
  let chunk = "";
  for (; i < lines.length; i++) {
    if (chunk.length + lines[i].length + 2 > 1024) {
      embed.addFields({ name: "​", value: chunk });
      chunk = "";
    }
    chunk += (chunk ? "\n\n" : "") + lines[i];
  }
  if (chunk) embed.addFields({ name: "​", value: chunk });
};

// Owner-only: what's still missing to run the shop.
const setupLines = async (guildId) => {
  const cfg = (await guildConfigSchema.findOne({ guildId }).lean().catch(() => null)) || {};
  const mark = (ok) => (ok ? "✅" : "❌");
  return [
    `${mark(config.gcash.number)} GCash number${config.gcash.number ? "" : " (`GCASH_NUMBER` in .env)"}`,
    `${mark(cfg.topupChannelId || cfg.logChannelId)} Approval channel${cfg.topupChannelId || cfg.logChannelId ? "" : " (`/settings approval-channel`)"}`,
    `${mark(cfg.salesChannelId)} Sales channel${cfg.salesChannelId ? "" : " (`/settings sales-channel`)"}`,
    `${mark(cfg.logChannelId)} Log channel${cfg.logChannelId ? "" : " (`/setlogchannel`)"}`,
    `${mark(cfg.storeChannelId)} Live store${cfg.storeChannelId ? "" : " (`/setupstore`)"}`,
  ];
};

const TAG = { user: "", staff: " · staff", owner: " · owner" };

async function renderHelp(client, interaction, sectionKey = "home") {
  const access = accessOf(interaction);
  const sections = sectionsFor(client, access);
  const section = sections.find((s) => s.key === sectionKey);
  const guild = interaction.guild;
  const embed = baseEmbed(interaction).setAuthor({ name: `${guild?.name || config.brand} • Help`, iconURL: guild?.iconURL?.() || client.user?.displayAvatarURL?.() || undefined });

  if (!section) {
    // ---- Home ---------------------------------------------------------------------
    const user = await userSchema.findOne({ guildId: guild.id, userId: interaction.user.id }).catch(() => null);
    embed.setTitle("📖 How can I help?").setDescription(
      [
        "**👋 New here? Buying takes 3 steps:**",
        "1️⃣ `/topup amount:100` → send it with GCash and upload the receipt",
        "2️⃣ `/store` → pick a product and press **Buy**",
        "3️⃣ Your item arrives in your **DMs** instantly",
        "",
        `👛 **Your balance:** ${bmoney(Number(user?.userBalance) || 0)}`,
      ].join("\n")
    );
    for (const s of sections) {
      const n = s.cmds.reduce((sum, c) => sum + entries(c).length, 0);
      embed.addFields({ name: `${s.emoji} ${s.name}`, value: `${s.blurb}\n*${n} command${n === 1 ? "" : "s"}${TAG[s.level] || ""}*`, inline: true });
    }
    if (access === "owner") embed.addFields({ name: "⚙️ Setup checklist", value: (await setupLines(guild.id)).join("\n") });
    embed.setFooter({ text: `${config.brand} • Pick a section below • Only you can see this` });
  } else {
    // ---- One section ----------------------------------------------------------------
    embed.setTitle(`${section.emoji} ${section.name}`);
    const lines = section.cmds.flatMap(entries).map((e) => `**\`${e.name}\`** ${e.args}\n› ${clip(cleanDesc(e.desc), 160)}`);
    fillBody(embed, [`*${section.blurb}*`, ...lines]);
    embed.setFooter({ text: `${config.brand} • <required> [optional] • Only you can see this` });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("help:section")
    .setPlaceholder("📂 Pick a section…")
    .addOptions(
      sections.map((s) => ({
        label: s.name,
        value: s.key,
        emoji: s.emoji,
        description: clip(s.blurb, 100),
        default: s.key === section?.key,
      }))
    );
  const home = new ButtonBuilder().setCustomId("help:home").setLabel("Home").setEmoji("🏠").setStyle(ButtonStyle.Secondary).setDisabled(!section);
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(home)],
  };
}

module.exports = {
  name: "help",
  category: "Information",
  categoryEmoji: "ℹ️",
  description: "How to buy, and every command you can use",
  hidden: false,

  callback: async (client, interaction) => interaction.reply({ ...(await renderHelp(client, interaction)), flags: MessageFlags.Ephemeral }),

  // Dropdown / Home button (routed from interactionCreate).
  handleSection: async (client, interaction, key) => interaction.update(await renderHelp(client, interaction, key)),
  renderHelp,
  SECTIONS,
};
