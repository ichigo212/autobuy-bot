const { ApplicationCommandOptionType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder, MessageFlags } = require("discord.js");
const { requireStaff } = require("../utils/permissions");
const { success, error } = require("../utils/embeds");
const { findProduct, updateProduct, collectCodes } = require("../utils/products");
const { scheduleRefresh } = require("../utils/liveEmbeds");

// Guided stock editing: /editstock <code> opens a modal so staff can change the
// price and/or replace the stock codes without remembering option syntax. The
// modal submit is handled in events/interaction/interactionCreate.js and reuses
// utils/products.updateProduct (so file-stock stays in sync).
//
// Discord modals can't contain file inputs, so to REPLACE stock from a .txt
// file, pass the `file` option on the command itself — when given, we process it
// directly (optionally with a `price`) and skip the popup.
module.exports = {
  name: "editstock",
  category: "Staff",
  description: "Edit a product's price and stock via a guided form (or upload a .txt file)",
  hidden: true,
  options: [
    {
      name: "code",
      description: "Product code to edit",
      type: ApplicationCommandOptionType.String,
      required: true,
    },
    {
      name: "file",
      description: "A .txt file of codes (one per line) that REPLACES the current stock",
      type: ApplicationCommandOptionType.Attachment,
      required: false,
    },
    {
      name: "price",
      description: "New price (only used together with a file upload)",
      type: ApplicationCommandOptionType.Integer,
      required: false,
      minValue: 0,
    },
  ],

  callback: async (client, interaction) => {
    if (!(await requireStaff(interaction))) return;

    const code = interaction.options.getString("code");
    const { product } = await findProduct(interaction.guild.id, code);
    if (!product) {
      return interaction.reply({
        embeds: [error(interaction, `Cannot find a product with code \`${code}\`.`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    const file = interaction.options.getAttachment("file");

    // File path: process directly (modals can't hold files), then done.
    if (file) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      let newCodes;
      try {
        newCodes = await collectCodes(null, file);
      } catch (err) {
        return interaction.followUp({ embeds: [error(interaction, err.message)], flags: MessageFlags.Ephemeral });
      }

      if (newCodes.length === 0) {
        return interaction.followUp({
          embeds: [error(interaction, "That file had no usable codes (one code per line).")],
          flags: MessageFlags.Ephemeral,
        });
      }

      const updates = {};
      const price = interaction.options.getInteger("price");
      if (price != null) updates.productPrice = price;

      const result = await updateProduct({
        guildId: interaction.guild.id,
        productCode: code,
        updates,
        newCodes,
      });

      if (!result.ok) {
        return interaction.followUp({ embeds: [error(interaction, result.message)], flags: MessageFlags.Ephemeral });
      }

      scheduleRefresh(client, interaction.guild.id);

      return interaction.followUp({
        embeds: [
          success(
            interaction,
            `Replaced stock for **${result.product.productName}** from the uploaded file — **${result.product.productStock}** code(s) now in stock.`
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    // No file: open the guided modal (price + typed codes).
    const modal = new ModalBuilder()
      .setCustomId(`editstock:submit:${code}`)
      .setTitle(`Edit stock — ${product.productName}`.slice(0, 45));

    const priceInput = new TextInputBuilder()
      .setCustomId("price")
      .setLabel("Price (leave as-is to keep)")
      .setStyle(TextInputStyle.Short)
      .setValue(String(product.productPrice ?? 0))
      .setRequired(false);

    const codesInput = new TextInputBuilder()
      .setCustomId("codes")
      .setLabel("New items — one per line (REPLACES stock)")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("Leave BLANK to keep current stock.\nITEM-1\nITEM-2\nITEM-3")
      .setMaxLength(4000)
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(priceInput),
      new ActionRowBuilder().addComponents(codesInput)
    );

    return interaction.showModal(modal);
  },
};
