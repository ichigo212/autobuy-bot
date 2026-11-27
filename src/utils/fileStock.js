const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { writeFileAtomic } = require("./atomicWrite");

// File-based stock system.
//
// Each product's deliverable items live in a plain .txt file, ONE ITEM PER LINE,
// namespaced per guild so two servers can safely use the same product code:
//
//   data/stock/<guildId>/<productCode>.txt
//
// An "item" is whatever the buyer receives: a code, a serial, a link, or an
// account like "user@mail.com:password". MongoDB keeps only product metadata and
// a numeric `productStock` mirror; this file is the source of truth for stock.
//
// Concurrency: every write is serialised per file via an in-process promise
// chain, so two simultaneous buyers can never receive the same item. Writes are
// atomic (temp file + rename) so a crash can't wipe a product's stock.

const STOCK_ROOT = path.join(__dirname, "..", "..", "data", "stock");

// Product codes become filenames, so only allow a safe, simple charset.
const PRODUCT_CODE_RE = /^[A-Za-z0-9_-]{1,40}$/;
const isValidProductCode = (code) => typeof code === "string" && PRODUCT_CODE_RE.test(code);

const fileFor = (guildId, productCode) => {
  if (!/^\d{5,25}$/.test(String(guildId)) || !isValidProductCode(String(productCode))) {
    throw new Error("Invalid guild id or product code for a stock file.");
  }
  return path.join(STOCK_ROOT, String(guildId), `${productCode}.txt`);
};

// Split a raw blob into items. Line endings are normalised first (\r\n / \r →
// \n). By default ONLY newlines separate items, so an item may contain commas.
// `allowCommas` is for single-line inputs (Discord slash-command string options
// can't contain new lines), where "A, B, C" means three items.
const parseCodes = (raw, { allowCommas = false } = {}) =>
  String(raw || "")
    .replace(/\r\n?/g, "\n")
    .split(allowCommas ? /[\n,]+/ : /\n+/)
    .map((c) => c.trim())
    .filter(Boolean);

const serialize = (codes) => codes.join("\n") + (codes.length ? "\n" : "");

// ---- Per-file lock ---------------------------------------------------------
const locks = new Map();

const withLock = (filePath, fn) => {
  const prev = locks.get(filePath) || Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  locks.set(filePath, run.then(() => {}, () => {}));
  return run;
};

const readFileCodes = async (filePath) => {
  try {
    return parseCodes(await fsp.readFile(filePath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
};

// ---- Reads -----------------------------------------------------------------

const hasCodeList = (guildId, productCode) => {
  try {
    return fs.existsSync(fileFor(guildId, productCode));
  } catch {
    return false;
  }
};

const readCodes = async (guildId, productCode) => {
  let filePath;
  try {
    filePath = fileFor(guildId, productCode);
  } catch {
    return [];
  }
  return readFileCodes(filePath);
};

const countCodes = async (guildId, productCode) => (await readCodes(guildId, productCode)).length;

// ---- Writes (all serialised per file) --------------------------------------

// Atomically remove and return up to `count` items from the front of the file.
const popCodes = (guildId, productCode, count = 1) => {
  const filePath = fileFor(guildId, productCode);
  return withLock(filePath, async () => {
    const codes = await readFileCodes(filePath);
    const take = Math.max(0, Math.min(count, codes.length));
    if (take === 0) return [];
    await writeFileAtomic(filePath, serialize(codes.slice(take)));
    return codes.slice(0, take);
  });
};

// Append items to the end of the file. Returns the new total count.
const appendCodes = (guildId, productCode, newCodes = []) => {
  const filePath = fileFor(guildId, productCode);
  return withLock(filePath, async () => {
    const merged = [...(await readFileCodes(filePath)), ...newCodes];
    await writeFileAtomic(filePath, serialize(merged));
    return merged.length;
  });
};

// Replace the entire item list. Returns the new count.
const replaceCodes = (guildId, productCode, codes = []) => {
  const filePath = fileFor(guildId, productCode);
  return withLock(filePath, async () => {
    await writeFileAtomic(filePath, serialize(codes));
    return codes.length;
  });
};

// Put items back at the FRONT (used when a purchase fails after items were
// taken, or when staff refund WITH restock). Returns the new total count.
const restoreCodes = (guildId, productCode, codes = []) => {
  const filePath = fileFor(guildId, productCode);
  return withLock(filePath, async () => {
    const merged = [...codes, ...(await readFileCodes(filePath))];
    await writeFileAtomic(filePath, serialize(merged));
    return merged.length;
  });
};

// Move a product's items to a new code (product rename). Refuses to overwrite
// an existing file for the new code.
const renameCodeList = async (guildId, fromCode, toCode) => {
  const from = fileFor(guildId, fromCode);
  const to = fileFor(guildId, toCode);
  return withLock(from, () =>
    withLock(to, async () => {
      if (fs.existsSync(to)) throw new Error(`Stock for \`${toCode}\` already exists.`);
      const codes = await readFileCodes(from);
      await writeFileAtomic(to, serialize(codes));
      await fsp.unlink(from).catch((err) => {
        if (err.code !== "ENOENT") throw err;
      });
      return codes.length;
    })
  );
};

const deleteCodeList = (guildId, productCode) => {
  const filePath = fileFor(guildId, productCode);
  return withLock(filePath, async () => {
    try {
      await fsp.unlink(filePath);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  });
};

module.exports = {
  parseCodes,
  isValidProductCode,
  hasCodeList,
  readCodes,
  countCodes,
  popCodes,
  appendCodes,
  replaceCodes,
  restoreCodes,
  renameCodeList,
  deleteCodeList,
  fileFor,
  STOCK_ROOT,
};
