const { ApplicationCommandOptionType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder, MessageFlags } = require("discord.js");
const { requireStaff } = require("../utils/permissions");
const { error } = require("../utils/embeds");
const { findProduct } = require("../utils/products");
const fileStock = require("../utils/fileStock");
const crypto = require("crypto");

// Fingerprint of a stock list, carried in the modal id so the submit handler
// knows (a) whether staff edited the items and (b) whether stock changed
// (e.g. a sale) while the form was open.
const stockHash = (codes) => crypto.createHash("sha1").update(codes.join("\n")).digest("hex").slice(0, 10);

// Guided delivery editing: /editdelivery <code> opens a modal so staff can change
// exactly what buyers receive (the delivery codes/serials) and the product's
// description, without remembering option syntax. Submit is handled in
// events/interaction/interactionCreate.js and reuses utils/products.updateProduct.
module.exports = {
  stockHash,
  name: "editdelivery",
  category: "Staff",
  description: "Edit what a product delivers (codes/serials) via a guided form",
  hidden: true,
  options: [
    {
      name: "code",
      description: "Product code to edit delivery for",
      type: ApplicationCommandOptionType.String,
      required: true,
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

    // Prefill the current delivery codes so staff can see/tweak what buyers get.
    // Cap the prefill so we never exceed Discord's 4000-char text input limit.
    let currentCodes = [];
    try {
      currentCodes = await fileStock.readCodes(interaction.guild.id, code);
    } catch {
      currentCodes = [];
    }
    // Only pre-fill when the WHOLE list fits in the form. A cut-off list would
    // replace (and silently delete) the rest of the stock on submit.
    const joined = currentCodes.join("\n");
    const prefill = joined.length <= 4000 ? joined : "";

    const modal = new ModalBuilder()
      .setCustomId(`editdelivery:submit:${code}:${stockHash(currentCodes)}`)
      .setTitle(`Edit delivery — ${product.productName}`.slice(0, 45));

    const codesInput = new TextInputBuilder()
      .setCustomId("codes")
      .setLabel(prefill || !currentCodes.length ? "Items — one per line (replaces stock)" : `Items (${currentCodes.length} in stock — blank = keep)`)
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder(currentCodes.length && !prefill ? "Too many items to show. Leave BLANK to keep them, or paste a full new list." : "Leave BLANK to keep current stock.\nITEM-1\nITEM-2")
      .setMaxLength(4000)
      .setRequired(false);
    if (prefill) codesInput.setValue(prefill);

    const descInput = new TextInputBuilder()
      .setCustomId("description")
      .setLabel("Description (shown in the store)")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false);
    descInput.setMaxLength(300);
    if (product.description) descInput.setValue(String(product.description).slice(0, 300));

    // The custom message the buyer receives with their delivery (e.g. redemption
    // instructions, a thank-you, a support link). Blank = use the default receipt.
    const msgInput = new TextInputBuilder()
      .setCustomId("deliverymessage")
      .setLabel("Delivery message (sent to the buyer)")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("e.g. Thanks for buying! Redeem your code at example.com/redeem")
      .setRequired(false);
    msgInput.setMaxLength(2000);
    if (product.deliveryMessage) msgInput.setValue(String(product.deliveryMessage).slice(0, 2000));

    // Link/referral buttons attached to the delivery DM. One per line as
    // "Label | https://url". Up to 5. Blank clears them.
    const buttonsInput = new TextInputBuilder()
      .setCustomId("buttons")
      .setLabel("Link buttons — Label | URL (one per line)")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("Join our server | https://discord.gg/xxx\nRefer a friend | https://example.com/ref")
      .setRequired(false);
    if (Array.isArray(product.deliveryButtons) && product.deliveryButtons.length) {
      buttonsInput.setValue(
        product.deliveryButtons.map((b) => `${b.label} | ${b.url}`).join("\n").slice(0, 3900)
      );
    }

    modal.addComponents(
      new ActionRowBuilder().addComponents(codesInput),
      new ActionRowBuilder().addComponents(descInput),
      new ActionRowBuilder().addComponents(msgInput),
      new ActionRowBuilder().addComponents(buttonsInput)
    );

    return interaction.showModal(modal);
  },
};
