const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const { requireStaff } = require("../utils/permissions");
const { renderDashboard, PERIODS, VIEWS } = require("../utils/analytics");

// /analytics — interactive sales & profit dashboard. Switch views with the menu
// and periods with the buttons; Export CSV for spreadsheets.
module.exports = {
  name: "analytics",
  category: "Staff",
  description: "Sales & profit dashboard: revenue, profit, products, customers, daily chart",
  hidden: true,
  options: [
    {
      name: "period",
      description: "Time window (default: last 7 days)",
      type: ApplicationCommandOptionType.String,
      required: false,
      choices: Object.entries(PERIODS).map(([value, p]) => ({ name: p.label, value })),
    },
    {
      name: "view",
      description: "Which page to open (default: overview)",
      type: ApplicationCommandOptionType.String,
      required: false,
      choices: Object.entries(VIEWS).map(([value, v]) => ({ name: v.label, value })),
    },
  ],

  callback: async (client, interaction) => {
    if (!(await requireStaff(interaction))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const period = interaction.options.getString("period") || "week";
    const view = interaction.options.getString("view") || "overview";
    return interaction.editReply(await renderDashboard(interaction, interaction.guild.id, period, view));
  },
};
