const storeSchema = require("../db/models/storeSchema");
const fileStock = require("./fileStock");
const bus = require("./bus");

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB of items is plenty

// Typed items from a slash-command option (single line → commas separate items).
const parseTypedCodes = (raw) => fileStock.parseCodes(raw, { allowCommas: true });

// Download a .txt attachment and parse it into items (one per line — commas are
// kept so items like "user:pass, region EU" survive). Throws a friendly Error.
const codesFromAttachment = async (attachment) => {
  if (!attachment) return [];

  const ext = attachment.name?.split(".").pop()?.toLowerCase();
  if (ext !== "txt") throw new Error("The uploaded stock file must be a `.txt` file (one item per line).");
  if (attachment.size > MAX_UPLOAD_BYTES) throw new Error("That file is too big (max 5 MB).");

  const res = await fetch(attachment.url);
  if (!res.ok) throw new Error(`Couldn't download the file (HTTP ${res.status}). Try uploading it again.`);
  return fileStock.parseCodes(await res.text());
};

// Merge items typed in the "codes" option with items from an uploaded file.
const collectCodes = async (rawCodes, attachment) => [
  ...parseTypedCodes(rawCodes),
  ...(await codesFromAttachment(attachment)),
];

const findProduct = async (guildId, productCode) => {
  const storeData = await storeSchema.findOne({ guildId });
  const product = storeData?.store.find((p) => p.productCode === productCode);
  return { storeData, product };
};

const invalidCodeMessage = (code) =>
  `\`${code}\` isn't a valid product code. Use 1–40 letters, numbers, \`-\` or \`_\` (no spaces).`;

// Create a product. Items are optional; they're written to the product's stock
// file and the DB keeps a numeric `productStock` mirror of the item count.
const addProduct = async ({ guildId, productName, productCode, productPrice, codes = [], emoji, description, cost }) => {
  if (!fileStock.isValidProductCode(productCode)) return { ok: false, message: invalidCodeMessage(productCode) };

  const existing = await storeSchema.findOne({ guildId, "store.productCode": productCode });
  if (existing) return { ok: false, message: `A product with code \`${productCode}\` already exists.` };

  // Write items first so stock is never advertised without the items existing.
  await fileStock.replaceCodes(guildId, productCode, codes);

  const payload = {
    productName: String(productName).slice(0, 100),
    productCode,
    productPrice: Math.max(0, Number(productPrice) || 0),
    productStock: codes.length,
    createdAt: new Date(),
  };
  if (emoji) payload.emoji = emoji;
  if (description) payload.description = String(description).slice(0, 300);
  if (cost != null && Number.isFinite(Number(cost))) payload.cost = Math.max(0, Number(cost));

  await storeSchema.findOneAndUpdate({ guildId }, { $setOnInsert: { guildId }, $push: { store: payload } }, { upsert: true });
  return { ok: true, product: payload };
};

// Update any subset of a product's fields. `newCodes` REPLACES the item list;
// `addCodes` appends to it. The DB `productStock` mirror always ends up equal to
// the stock file's item count.
const updateProduct = async ({ guildId, productCode, updates = {}, addCodes, newCodes }) => {
  const { storeData, product } = await findProduct(guildId, productCode);
  if (!product) return { ok: false, message: `Cannot find a product with code \`${productCode}\`.` };

  const finalCode = updates.productCode || productCode;
  const renaming = finalCode !== productCode;
  if (renaming) {
    if (!fileStock.isValidProductCode(finalCode)) return { ok: false, message: invalidCodeMessage(finalCode) };
    if (storeData.store.some((p) => p.productCode === finalCode)) {
      return { ok: false, message: `A product with code \`${finalCode}\` already exists — pick another code.` };
    }
  }

  const set = {};
  if (updates.productName != null) set["store.$.productName"] = String(updates.productName).slice(0, 100);
  if (updates.productPrice != null) set["store.$.productPrice"] = Math.max(0, Number(updates.productPrice) || 0);
  if (renaming) set["store.$.productCode"] = finalCode;
  if (updates.emoji != null) set["store.$.emoji"] = updates.emoji;
  if (updates.description != null) set["store.$.description"] = String(updates.description).slice(0, 300);
  if (updates.deliveryMessage != null) set["store.$.deliveryMessage"] = String(updates.deliveryMessage).slice(0, 2000);
  if (updates.cost !== undefined) set["store.$.cost"] = updates.cost === null ? null : Math.max(0, Number(updates.cost));
  if (updates.deliveryButtons != null) set["store.$.deliveryButtons"] = updates.deliveryButtons;
  if (updates.category !== undefined) set["store.$.category"] = updates.category ? String(updates.category).trim().slice(0, 60) : null;

  const hasCodeChange = Array.isArray(newCodes) || (Array.isArray(addCodes) && addCodes.length > 0);
  if (Object.keys(set).length === 0 && !hasCodeChange) {
    return { ok: false, message: "Nothing to update — provide at least one field." };
  }

  const stockBefore = await fileStock.countCodes(guildId, productCode);

  // Item changes on the current file, then move the file if renaming.
  if (Array.isArray(newCodes)) await fileStock.replaceCodes(guildId, productCode, newCodes);
  else if (Array.isArray(addCodes) && addCodes.length) await fileStock.appendCodes(guildId, productCode, addCodes);
  if (renaming) await fileStock.renameCodeList(guildId, productCode, finalCode);

  set["store.$.productStock"] = await fileStock.countCodes(guildId, finalCode);

  const updated = await storeSchema.findOneAndUpdate(
    { guildId, "store.productCode": productCode },
    { $set: set },
    { new: true }
  );

  const stockAfter = set["store.$.productStock"];
  if (stockBefore === 0 && stockAfter > 0) bus.emit("restock", { guildId, productCode: finalCode, stock: stockAfter });

  return { ok: true, product: updated?.store.find((p) => p.productCode === finalCode) };
};

// Re-sync a product's numeric stock mirror with its stock file.
const syncStock = async (guildId, productCode) => {
  const remaining = await fileStock.countCodes(guildId, productCode);
  await storeSchema.updateOne(
    { guildId, "store.productCode": productCode },
    { $set: { "store.$.productStock": remaining } }
  );
  return remaining;
};

// Remove a product entirely, including its stock file.
const removeProduct = async ({ guildId, productCode }) => {
  const { product } = await findProduct(guildId, productCode);
  if (!product) return { ok: false, message: `Cannot find a product with code \`${productCode}\`.` };

  await storeSchema.updateOne({ guildId }, { $pull: { store: { productCode } } });
  await fileStock.deleteCodeList(guildId, productCode).catch(() => {});
  return { ok: true, product };
};

// Parse "Label | https://url" lines into validated link-button specs (max 5).
const parseDeliveryButtons = (raw) => {
  const buttons = [];
  const errors = [];
  const lines = String(raw || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (buttons.length >= 5) {
      errors.push("Only the first 5 buttons were kept (Discord allows max 5).");
      break;
    }
    const idx = line.lastIndexOf("|");
    if (idx === -1) {
      errors.push(`"${line}" is missing a \`|\` between the label and the URL.`);
      continue;
    }
    const label = line.slice(0, idx).trim();
    const url = line.slice(idx + 1).trim();
    if (!label) { errors.push(`A button on "${line}" has no label.`); continue; }
    if (!/^https?:\/\/\S+$/i.test(url)) { errors.push(`"${url}" isn't a valid http(s) link.`); continue; }
    buttons.push({ label: label.slice(0, 80), url });
  }
  return { buttons, errors };
};

module.exports = {
  parseTypedCodes,
  parseDeliveryButtons,
  codesFromAttachment,
  collectCodes,
  findProduct,
  addProduct,
  updateProduct,
  removeProduct,
  syncStock,
};
