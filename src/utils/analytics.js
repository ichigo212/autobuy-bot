const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require("discord.js");
const config = require("../config");
const { baseEmbed, COLORS, getStock } = require("./embeds");
const { money, bmoney, clip } = require("./format");
const saleSchema = require("../db/models/saleSchema");
const storeSchema = require("../db/models/storeSchema");
const expenseSchema = require("../db/models/expenseSchema");
const guildConfigSchema = require("../db/models/guildConfigSchema");
const topupRequestSchema = require("../db/models/topupRequestSchema");

// ---------------------------------------------------------------------------
// Analytics engine behind the /analytics dashboard and the nightly report.
//
// Profit model (simple on purpose):
//   gross profit = Σ (price − cost) × qty       ← cost is snapshotted on each sale
//   net profit   = gross profit − expenses       ← expenses logged with /expense
// Refunded sales are excluded everywhere (and counted separately).
// Days are calendar days in config.timezone (default Asia/Manila).
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const tz = config.timezone;
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" });

const dayKey = (d) => dayFmt.format(new Date(d)); // "2026-11-18"
const hourOf = (d) => Number(hourFmt.format(new Date(d))) % 24;
const keysBack = (count, offset = 0) => Array.from({ length: count }, (_, i) => dayKey(Date.now() - (offset + i) * DAY)).reverse();
const dayLabel = (key) => new Date(`${key}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const hourLabel = (h) => `${h % 12 || 12}${h < 12 ? "am" : "pm"}`;

const PERIODS = {
  today: { label: "Today", days: 1, offset: 0 },
  yesterday: { label: "Yesterday", days: 1, offset: 1 },
  week: { label: "Last 7 days", days: 7, offset: 0 },
  month: { label: "Last 30 days", days: 30, offset: 0 },
  all: { label: "All time", days: null },
};
const VIEWS = {
  overview: { label: "Overview", emoji: "📊", description: "Revenue, profit, orders and trends" },
  products: { label: "Products", emoji: "📦", description: "Per-product profit, margin and stock forecast" },
  customers: { label: "Customers", emoji: "👥", description: "Top buyers, new vs returning" },
  daily: { label: "Daily chart", emoji: "📈", description: "Revenue and profit day by day" },
};

// The set of day keys a period covers (null = no limit), and the period before it.
const periodDays = (p) => (p.days ? new Set(keysBack(p.days, p.offset)) : null);
const previousDays = (p) => (p.days ? new Set(keysBack(p.days, p.offset + p.days)) : null);

const inPeriod = (days, date) => !days || days.has(dayKey(date));

const emptyMetrics = () => ({
  revenue: 0, cogs: 0, grossProfit: 0, costedRevenue: 0, expenses: 0,
  orders: 0, units: 0, buyers: new Set(), refunds: 0, refundAmount: 0, failed: 0,
  topups: 0, topupCount: 0,
});

const addSale = (m, s) => {
  if (s.refunded) {
    m.refunds += 1;
    m.refundAmount += s.price || 0;
    return;
  }
  const qty = s.quantity || 1;
  m.revenue += s.price || 0;
  m.orders += 1;
  m.units += qty;
  m.buyers.add(s.userId);
  if (s.delivered === false) m.failed += 1;
  if (s.profitPerUnit != null) {
    m.grossProfit += s.profitPerUnit * qty;
    m.cogs += (s.costPerUnit ?? (s.unitPrice ?? 0) - s.profitPerUnit) * qty;
    m.costedRevenue += s.price || 0;
  }
};

const finish = (m) => {
  const netProfit = m.grossProfit - m.expenses;
  return {
    ...m,
    buyers: m.buyers.size,
    netProfit,
    margin: m.revenue > 0 ? (m.grossProfit / m.revenue) * 100 : null,
    avgOrder: m.orders ? m.revenue / m.orders : 0,
    costCoverage: m.revenue > 0 ? (m.costedRevenue / m.revenue) * 100 : 100,
  };
};

// Load everything for a guild once and compute all views for a period.
const computeStats = async (guildId, periodKey = "week") => {
  const period = PERIODS[periodKey] || PERIODS.week;
  const [allSalesRaw, store, expensesRaw, cfg, topupsRaw] = await Promise.all([
    saleSchema.find({ guildId }, { deliveredCodes: 0, deliveredCode: 0 }).sort({ createdAt: 1 }).lean(),
    storeSchema.findOne({ guildId }).lean(),
    expenseSchema.find({ guildId }).lean(),
    guildConfigSchema.findOne({ guildId }).lean(),
    topupRequestSchema.find({ guildId, status: "approved" }),
  ]);

  // Honour /resetanalytics: ignore anything before the reset point.
  const resetAt = cfg?.analyticsResetAt ? new Date(cfg.analyticsResetAt) : null;
  const after = (d) => !resetAt || new Date(d) >= resetAt;
  const allSales = allSalesRaw.filter((s) => after(s.createdAt));
  const expenses = expensesRaw.filter((e) => after(e.createdAt));
  const topups = topupsRaw.filter((t) => after(t.decidedAt || t.createdAt));

  const curDays = periodDays(period);
  const prevDays = previousDays(period);
  const cur = emptyMetrics();
  const prev = prevDays ? emptyMetrics() : null;

  const firstSeen = new Map(); // userId -> first non-refunded order date
  for (const s of allSales) {
    if (!s.refunded && !firstSeen.has(s.userId)) firstSeen.set(s.userId, s.createdAt);
    if (inPeriod(curDays, s.createdAt)) addSale(cur, s);
    else if (prev && inPeriod(prevDays, s.createdAt)) addSale(prev, s);
  }
  for (const e of expenses) {
    if (inPeriod(curDays, e.createdAt)) cur.expenses += e.amount;
    else if (prev && inPeriod(prevDays, e.createdAt)) prev.expenses += e.amount;
  }
  for (const t of topups) {
    const when = t.decidedAt || t.createdAt;
    if (inPeriod(curDays, when)) { cur.topups += t.amount; cur.topupCount += 1; }
    else if (prev && inPeriod(prevDays, when)) { prev.topups += t.amount; prev.topupCount += 1; }
  }

  const sales = allSales.filter((s) => !s.refunded && inPeriod(curDays, s.createdAt));

  // New customers = first-ever order falls inside this period.
  const periodBuyers = new Set(sales.map((s) => s.userId));
  const newCustomers = [...periodBuyers].filter((u) => inPeriod(curDays, firstSeen.get(u))).length;

  // Best day & busiest hour.
  const byDay = {};
  const byHour = Array(24).fill(0);
  for (const s of sales) {
    const k = dayKey(s.createdAt);
    byDay[k] ||= { revenue: 0, profit: 0, orders: 0 };
    byDay[k].revenue += s.price || 0;
    byDay[k].profit += s.profitPerUnit != null ? s.profitPerUnit * (s.quantity || 1) : 0;
    byDay[k].orders += 1;
    byHour[hourOf(s.createdAt)] += 1;
  }
  const bestDay = Object.entries(byDay).sort((a, b) => b[1].revenue - a[1].revenue)[0] || null;
  const busiest = byHour.some(Boolean) ? byHour.indexOf(Math.max(...byHour)) : null;

  // Products: period performance + stock forecast from the last 7 days' pace.
  const last7 = new Set(keysBack(7));
  const catalog = store?.store || [];
  const prodMap = new Map();
  const touch = (code, name) => {
    if (!prodMap.has(code)) prodMap.set(code, { code, name, units: 0, revenue: 0, profit: 0, costed: false, units7: 0, stock: null, cost: null, price: null });
    return prodMap.get(code);
  };
  for (const p of catalog) Object.assign(touch(p.productCode, p.productName), { stock: getStock(p), cost: p.cost ?? null, price: p.productPrice, name: p.productName });
  for (const s of allSales) {
    if (s.refunded) continue;
    const row = touch(s.productCode, s.productName);
    if (last7.has(dayKey(s.createdAt))) row.units7 += s.quantity || 1;
    if (!inPeriod(curDays, s.createdAt)) continue;
    row.units += s.quantity || 1;
    row.revenue += s.price || 0;
    if (s.profitPerUnit != null) { row.profit += s.profitPerUnit * (s.quantity || 1); row.costed = true; }
  }
  const products = [...prodMap.values()].map((r) => {
    const perDay = r.units7 / 7;
    return { ...r, perDay, daysLeft: r.stock != null && perDay > 0 ? r.stock / perDay : null };
  });

  // Customers in the period.
  const byBuyer = {};
  for (const s of sales) {
    byBuyer[s.userId] ||= { userId: s.userId, orders: 0, spent: 0, units: 0 };
    byBuyer[s.userId].orders += 1;
    byBuyer[s.userId].spent += s.price || 0;
    byBuyer[s.userId].units += s.quantity || 1;
  }
  const buyers = Object.values(byBuyer).sort((a, b) => b.spent - a.spent);

  // Daily series for the chart (at least 7 days so it's worth looking at).
  const chartKeys = period.days ? keysBack(Math.max(period.days, 7), period.offset) : keysBack(30);
  const dailyAll = {};
  for (const s of allSales) {
    if (s.refunded) continue;
    const k = dayKey(s.createdAt);
    dailyAll[k] ||= { revenue: 0, profit: 0, orders: 0 };
    dailyAll[k].revenue += s.price || 0;
    dailyAll[k].profit += s.profitPerUnit != null ? s.profitPerUnit * (s.quantity || 1) : 0;
    dailyAll[k].orders += 1;
  }
  const daily = chartKeys.map((k) => ({ key: k, ...(dailyAll[k] || { revenue: 0, profit: 0, orders: 0 }) }));

  return {
    periodKey: PERIODS[periodKey] ? periodKey : "week",
    label: period.label,
    resetAt,
    cur: finish(cur),
    prev: prev ? finish(prev) : null,
    newCustomers,
    returning: periodBuyers.size - newCustomers,
    repeatBuyers: buyers.filter((b) => b.orders > 1).length,
    bestDay,
    busiest,
    products,
    buyers,
    daily,
    missingCost: catalog.filter((p) => p.cost == null).map((p) => p.productCode),
    sales,
  };
};

// ---- Rendering ---------------------------------------------------------------

const delta = (cur, prev) => {
  if (prev == null) return "";
  if (prev === 0) return cur > 0 ? " · 🆕" : "";
  const d = ((cur - prev) / Math.abs(prev)) * 100;
  if (Math.abs(d) < 0.5) return " · ➖ 0%";
  return ` · ${d > 0 ? "🔺" : "🔻"} ${Math.abs(d).toFixed(0)}%`;
};
const pct = (n) => (n == null ? "—" : `${n.toFixed(1)}%`);
const bar = (value, max, width = 10) => {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  return "█".repeat(filled) + "░".repeat(width - filled);
};

const header = (ctx, stats, view) => {
  const e = baseEmbed(ctx).setTitle(`${VIEWS[view].emoji} Analytics — ${VIEWS[view].label}`);
  const lines = [`📅 **${stats.label}**${stats.prev ? " · compared with the period before" : ""}`];
  if (stats.resetAt) lines.push(`♻️ Counting from <t:${Math.floor(stats.resetAt.getTime() / 1000)}:f> (\`/resetanalytics undo\` to show everything)`);
  return e.setDescription(lines.join("\n"));
};

const renderOverview = (ctx, s) => {
  const c = s.cur, p = s.prev;
  const e = header(ctx, s, "overview").setColor(c.netProfit >= 0 ? COLORS.success : COLORS.error);
  e.addFields(
    { name: "💰 Revenue", value: `${bmoney(c.revenue)}${delta(c.revenue, p?.revenue)}`, inline: true },
    { name: "💹 Gross profit", value: `${bmoney(c.grossProfit)}${delta(c.grossProfit, p?.grossProfit)}`, inline: true },
    { name: "🧾 Net profit", value: `${bmoney(c.netProfit)}${delta(c.netProfit, p?.netProfit)}`, inline: true },
    { name: "📦 Cost of items", value: bmoney(c.cogs), inline: true },
    { name: "💸 Expenses", value: bmoney(c.expenses), inline: true },
    { name: "📈 Margin", value: pct(c.margin), inline: true },
    { name: "🛒 Orders", value: `**${c.orders}** (${c.units} items)${delta(c.orders, p?.orders)}`, inline: true },
    { name: "🧮 Avg order", value: bmoney(c.avgOrder), inline: true },
    { name: "👥 Buyers", value: `**${c.buyers}** · 🆕 ${s.newCustomers} new`, inline: true },
    { name: "💙 GCash top-ups", value: `${bmoney(c.topups)} (${c.topupCount})${delta(c.topups, p?.topups)}`, inline: true },
    { name: "🏆 Best day", value: s.bestDay ? `${dayLabel(s.bestDay[0])} — ${money(s.bestDay[1].revenue)}` : "—", inline: true },
    { name: "⏰ Busiest hour", value: s.busiest != null ? `${hourLabel(s.busiest)}–${hourLabel((s.busiest + 1) % 24)}` : "—", inline: true }
  );
  const notes = [];
  if (c.refunds) notes.push(`↩️ ${c.refunds} refund(s) — ${money(c.refundAmount)} (not counted above)`);
  if (c.failed) notes.push(`⚠️ ${c.failed} order(s) couldn't be DMed — buyers saw them in-channel`);
  if (c.revenue > 0 && c.costCoverage < 99.5) notes.push(`ℹ️ Profit only covers ${c.costCoverage.toFixed(0)}% of revenue — some sales had no cost set.`);
  if (s.missingCost.length) notes.push(`💡 No cost set for: ${s.missingCost.slice(0, 8).map((x) => `\`${x}\``).join(", ")}${s.missingCost.length > 8 ? "…" : ""} → \`/setcost\``);
  if (notes.length) e.addFields({ name: "Notes", value: notes.join("\n").slice(0, 1024) });
  return e;
};

const renderProducts = (ctx, s) => {
  const e = header(ctx, s, "products");
  const rows = [...s.products].sort((a, b) => b.revenue - a.revenue || (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9));
  if (!rows.length) return e.addFields({ name: "No products", value: "Add one with `/addproduct`." });

  for (const r of rows.slice(0, 18)) {
    const margin = r.costed && r.revenue ? ` (${((r.profit / r.revenue) * 100).toFixed(0)}%)` : "";
    let stock = r.stock == null ? "removed" : `${r.stock} left`;
    if (r.stock === 0) stock = "🔴 sold out";
    else if (r.daysLeft != null && r.daysLeft <= 3) stock += ` · ⚠️ ~${Math.max(1, Math.round(r.daysLeft))}d — restock soon`;
    else if (r.daysLeft != null) stock += ` · ~${Math.round(r.daysLeft)}d`;
    e.addFields({
      name: clip(`${r.name} (${r.code})`, 256),
      value: [
        `🛒 ${r.units} sold · ${bmoney(r.revenue)}`,
        r.costed ? `💹 ${bmoney(r.profit)} profit${margin}` : r.cost == null ? "💹 *no cost set*" : "💹 —",
        `📦 ${stock}`,
      ].join("\n"),
      inline: true,
    });
  }
  if (rows.length > 18) e.addFields({ name: "​", value: `…and ${rows.length - 18} more product(s).` });
  e.setFooter({ text: `${config.brand} • Stock forecast uses the last 7 days' sales pace` });
  return e;
};

const renderCustomers = (ctx, s) => {
  const e = header(ctx, s, "customers");
  const c = s.cur;
  e.addFields(
    { name: "👥 Buyers", value: `**${c.buyers}**`, inline: true },
    { name: "🆕 New", value: `**${s.newCustomers}**`, inline: true },
    { name: "🔁 Returning", value: `**${s.returning}**`, inline: true },
    { name: "🔂 Bought 2+ times", value: `**${s.repeatBuyers}** (${c.buyers ? ((s.repeatBuyers / c.buyers) * 100).toFixed(0) : 0}%)`, inline: true },
    { name: "💵 Avg spend / buyer", value: bmoney(c.buyers ? c.revenue / c.buyers : 0), inline: true },
    { name: "🧮 Avg order", value: bmoney(c.avgOrder), inline: true }
  );
  const medals = ["🥇", "🥈", "🥉"];
  const top = s.buyers.slice(0, 10).map((b, i) => `${medals[i] || `\`#${i + 1}\``} <@${b.userId}> — ${bmoney(b.spent)} · ${b.orders} order(s)`);
  e.addFields({ name: "🏆 Top buyers", value: top.join("\n") || "No buyers in this period." });
  return e;
};

const renderDaily = (ctx, s) => {
  const e = header(ctx, s, "daily");
  const max = Math.max(...s.daily.map((d) => d.revenue), 0);
  const lines = s.daily.map((d) => `${dayLabel(d.key).padEnd(6)} ${bar(d.revenue, max)} ${money(d.revenue).padStart(10)}  ${d.orders ? `${d.orders}×` : "  "}`);
  const total = s.daily.reduce((a, d) => a + d.revenue, 0);
  const totalProfit = s.daily.reduce((a, d) => a + d.profit, 0);
  const activeDays = s.daily.filter((d) => d.revenue > 0).length;
  // Split across fields to respect the 1024-char limit per field.
  for (let i = 0; i < lines.length; i += 15) {
    e.addFields({ name: i === 0 ? "Revenue per day" : "​", value: `\`\`\`\n${lines.slice(i, i + 15).join("\n")}\n\`\`\`` });
  }
  e.addFields(
    { name: "Σ Revenue", value: bmoney(total), inline: true },
    { name: "Σ Profit", value: bmoney(totalProfit), inline: true },
    { name: "Avg / active day", value: bmoney(activeDays ? total / activeDays : 0), inline: true }
  );
  return e;
};

const RENDER = { overview: renderOverview, products: renderProducts, customers: renderCustomers, daily: renderDaily };

const dashboardComponents = (periodKey, view) => [
  new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`an:v:${periodKey}`)
      .setPlaceholder("Choose a view")
      .addOptions(Object.entries(VIEWS).map(([value, v]) => ({ value, label: v.label, emoji: v.emoji, description: v.description, default: value === view })))
  ),
  new ActionRowBuilder().addComponents(
    Object.entries(PERIODS).map(([key, p]) =>
      new ButtonBuilder()
        .setCustomId(`an:p:${key}:${view}`)
        .setLabel(p.label.replace("Last ", ""))
        .setStyle(key === periodKey ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(key === periodKey)
    )
  ),
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`an:r:${periodKey}:${view}`).setLabel("Refresh").setEmoji("🔄").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`an:csv:${periodKey}`).setLabel("Export CSV").setEmoji("📄").setStyle(ButtonStyle.Secondary)
  ),
];

const renderDashboard = async (ctx, guildId, periodKey = "week", view = "overview") => {
  const stats = await computeStats(guildId, periodKey);
  const v = RENDER[view] ? view : "overview";
  return { embeds: [RENDER[v](ctx, stats)], components: dashboardComponents(stats.periodKey, v) };
};

// CSV of the period's sales (refunds included, flagged) for spreadsheets.
const buildCsv = async (guildId, periodKey) => {
  const period = PERIODS[periodKey] || PERIODS.week;
  const days = periodDays(period);
  const sales = (await saleSchema.find({ guildId }, { deliveredCodes: 0, deliveredCode: 0 }).sort({ createdAt: 1 }).lean()).filter((s) => inPeriod(days, s.createdAt));
  const esc = (v) => {
    const t = v == null ? "" : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const head = ["date", "time", "order_id", "buyer_id", "product_code", "product_name", "qty", "unit_price", "total", "cost_per_unit", "profit", "refunded", "dm_delivered"];
  const rows = sales.map((s) => [
    dayKey(s.createdAt),
    new Date(s.createdAt).toLocaleTimeString("en-GB", { timeZone: tz }),
    s.orderId, s.userId, s.productCode, s.productName, s.quantity || 1,
    s.unitPrice ?? "", s.price, s.costPerUnit ?? "",
    s.profitPerUnit != null ? s.profitPerUnit * (s.quantity || 1) : "",
    s.refunded ? "yes" : "no", s.delivered === false ? "no" : "yes",
  ]);
  return { csv: [head, ...rows].map((r) => r.map(esc).join(",")).join("\n"), count: sales.length, label: period.label };
};

// Compact summary of yesterday for the nightly report.
const buildDailyReportEmbed = async (guild) => {
  const s = await computeStats(guild.id, "yesterday");
  const c = s.cur;
  const top = [...s.products].filter((r) => r.units).sort((a, b) => b.revenue - a.revenue)[0];
  const lowStock = s.products.filter((r) => r.stock != null && (r.stock === 0 || (r.daysLeft != null && r.daysLeft <= 3)));
  const e = baseEmbed({ guild })
    .setColor(c.netProfit >= 0 ? COLORS.success : COLORS.error)
    .setTitle(`📅 Daily report — ${dayLabel(keysBack(1, 1)[0])}`)
    .addFields(
      { name: "💰 Revenue", value: `${bmoney(c.revenue)}${delta(c.revenue, s.prev?.revenue)}`, inline: true },
      { name: "💹 Gross profit", value: bmoney(c.grossProfit), inline: true },
      { name: "🧾 Net profit", value: bmoney(c.netProfit), inline: true },
      { name: "🛒 Orders", value: `${c.orders} (${c.units} items)`, inline: true },
      { name: "👥 Buyers", value: `${c.buyers} · 🆕 ${s.newCustomers}`, inline: true },
      { name: "💙 GCash in", value: bmoney(c.topups), inline: true },
      { name: "🏆 Top product", value: top ? `${top.name} — ${top.units} sold · ${money(top.revenue)}` : "—" }
    );
  if (lowStock.length) {
    e.addFields({ name: "⚠️ Restock soon", value: lowStock.slice(0, 10).map((r) => `\`${r.code}\` ${r.name} — ${r.stock === 0 ? "sold out" : `${r.stock} left`}`).join("\n") });
  }
  return e.setFooter({ text: `${config.brand} • Full details: /analytics` });
};

module.exports = { PERIODS, VIEWS, computeStats, renderDashboard, buildCsv, buildDailyReportEmbed, dayKey, keysBack };
