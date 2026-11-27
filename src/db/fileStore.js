const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { writeFileAtomic } = require("../utils/atomicWrite");

// ---------------------------------------------------------------------------
// File-backed collection store.
//
// A tiny drop-in for the subset of the Mongoose model API this bot uses, so a
// collection (e.g. balances, recovery keys) can live in a plain JSON file that
// survives restarts with no database process at all.
//
// Each collection is one JSON file: an array of plain documents. Every mutating
// operation runs under a per-file promise-chain lock (serial access, no
// interleaving) and persists via a temp-file + atomic rename, so a crash mid
// write can never corrupt the live file. This preserves the two guarantees the
// MongoDB code relied on:
//   1. Atomic conditional updates — e.g. debit only if balance >= total — so two
//      concurrent purchases can't both pass a stale check and overspend.
//   2. Durability — a committed write is on disk before the call resolves.
//
// Supported query operators (in a filter): plain equality, plus $gte, $gt,
// $lte, $lt, $ne, $eq, $in, $nin. Supported update operators: $inc, $set,
// $setOnInsert, $push, $max. Supported options: upsert, new (return post-update doc;
// default true here — callers that need the pre-image pass { new: false }).
//
// This is intentionally NOT a general Mongo emulator — it implements exactly
// what the balance/recovery call sites use, and throws on anything unexpected so
// a future misuse fails loudly instead of silently misbehaving.
// ---------------------------------------------------------------------------

const DATA_ROOT = path.join(__dirname, "..", "..", "data", "store");

// ---- Query matching --------------------------------------------------------

const matchesCondition = (value, cond) => {
  // A condition object with operators, e.g. { $gte: 5, $ne: 0 }.
  if (cond && typeof cond === "object" && !Array.isArray(cond)) {
    const ops = Object.keys(cond);
    // Only treat it as an operator object if every key is an operator; otherwise
    // it's a plain-object equality (not used by our call sites, but be safe).
    if (ops.length > 0 && ops.every((k) => k.startsWith("$"))) {
      for (const op of ops) {
        const operand = cond[op];
        switch (op) {
          case "$gte": if (!(value >= operand)) return false; break;
          case "$gt": if (!(value > operand)) return false; break;
          case "$lte": if (!(value <= operand)) return false; break;
          case "$lt": if (!(value < operand)) return false; break;
          case "$eq": if (!(value === operand)) return false; break;
          case "$ne": if (value === operand) return false; break;
          case "$in": if (!Array.isArray(operand) || !operand.includes(value)) return false; break;
          case "$nin": if (Array.isArray(operand) && operand.includes(value)) return false; break;
          default: throw new Error(`fileStore: unsupported query operator ${op}`);
        }
      }
      return true;
    }
  }
  // Plain equality.
  return value === cond;
};

const matchesFilter = (doc, filter) => {
  for (const key of Object.keys(filter)) {
    if (key.startsWith("$")) {
      throw new Error(`fileStore: unsupported top-level filter operator ${key}`);
    }
    if (!matchesCondition(doc[key], filter[key])) return false;
  }
  return true;
};

// ---- Update application ----------------------------------------------------

// Apply a Mongo-style update to a doc in place. `isInsert` gates $setOnInsert.
const applyUpdate = (doc, update, isInsert) => {
  // A bare-object update (no operators) is unusual here; support $-operators only.
  for (const op of Object.keys(update)) {
    const spec = update[op];
    switch (op) {
      case "$inc":
        for (const [k, v] of Object.entries(spec)) {
          if (!Number.isFinite(v)) throw new Error(`fileStore: $inc on ${k} needs a finite number`);
          doc[k] = (Number(doc[k]) || 0) + v;
        }
        break;
      case "$max":
        // Applied after any $inc in the same update (key order), e.g.
        // { $inc: { userBalance: -50 }, $max: { userBalance: 0 } } clamps at 0.
        for (const [k, v] of Object.entries(spec)) doc[k] = Math.max(Number(doc[k]) || 0, v);
        break;
      case "$set":
        for (const [k, v] of Object.entries(spec)) doc[k] = v;
        break;
      case "$setOnInsert":
        if (isInsert) for (const [k, v] of Object.entries(spec)) doc[k] = v;
        break;
      case "$push":
        for (const [k, v] of Object.entries(spec)) {
          if (!Array.isArray(doc[k])) doc[k] = [];
          doc[k].push(v);
        }
        break;
      default:
        throw new Error(`fileStore: unsupported update operator ${op}`);
    }
  }
  return doc;
};

// ---- Per-file lock ---------------------------------------------------------
// Map<filePath, Promise>. Each op chains onto the previous for the same file.
const locks = new Map();

const withLock = (filePath, fn) => {
  const prev = locks.get(filePath) || Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  locks.set(filePath, run.then(() => {}, () => {}));
  return run;
};

// ---- Persistence -----------------------------------------------------------

const clone = (v) => JSON.parse(JSON.stringify(v));

class Collection {
  constructor(name) {
    this.name = name;
    this.file = path.join(DATA_ROOT, `${name}.json`);
  }

  // Read the whole collection as an array (no lock — callers that mutate do so
  // under withLock and re-read inside the lock).
  async _readAll() {
    try {
      const text = await fsp.readFile(this.file, "utf8");
      const data = JSON.parse(text);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      if (err.code === "ENOENT") return [];
      // A corrupt file should not silently wipe data — surface it.
      throw new Error(`fileStore: failed to read ${this.name}.json — ${err.message}`);
    }
  }

  // Atomic write: temp file + rename, so the live file is never half-written.
  async _writeAll(docs) {
    await writeFileAtomic(this.file, JSON.stringify(docs, null, 2));
  }

  // ---- Read API (return clones so callers can't mutate the store) ----------

  async findOne(filter = {}) {
    const docs = await this._readAll();
    const found = docs.find((d) => matchesFilter(d, filter));
    return found ? clone(found) : null;
  }

  // find(filter) → a thin chainable supporting .sort().limit() and await/.lean().
  find(filter = {}) {
    const self = this;
    let _sort = null;
    let _limit = null;
    const exec = async () => {
      const docs = await self._readAll();
      let out = docs.filter((d) => matchesFilter(d, filter));
      if (_sort) {
        const [[field, dir]] = Object.entries(_sort);
        out.sort((a, b) => {
          const av = a[field] ?? 0;
          const bv = b[field] ?? 0;
          if (av < bv) return dir === 1 ? -1 : 1;
          if (av > bv) return dir === 1 ? 1 : -1;
          return 0;
        });
      }
      if (_limit != null) out = out.slice(0, _limit);
      return out.map(clone);
    };
    return {
      sort(s) { _sort = s; return this; },
      limit(n) { _limit = n; return this; },
      lean() { return exec(); },
      then(resolve, reject) { return exec().then(resolve, reject); },
    };
  }

  async countDocuments(filter = {}) {
    const docs = await this._readAll();
    return docs.filter((d) => matchesFilter(d, filter)).length;
  }

  // ---- Write API (all serialised per file) ---------------------------------

  async create(docOrDocs) {
    return withLock(this.file, async () => {
      const docs = await this._readAll();
      const toAdd = Array.isArray(docOrDocs) ? docOrDocs : [docOrDocs];
      const added = toAdd.map((d) => clone(d));
      docs.push(...added);
      await this._writeAll(docs);
      return Array.isArray(docOrDocs) ? added.map(clone) : clone(added[0]);
    });
  }

  // findOneAndUpdate with { upsert, new } support. Returns the post-update doc by
  // default; { new: false } returns the pre-update image (null if it was an
  // insert), matching Mongoose. The whole read-modify-write is under the lock, so
  // a conditional update (filter includes e.g. userBalance:{$gte:x}) is atomic.
  async findOneAndUpdate(filter, update, options = {}) {
    const { upsert = false, new: returnNew = true } = options;
    return withLock(this.file, async () => {
      const docs = await this._readAll();
      const idx = docs.findIndex((d) => matchesFilter(d, filter));

      if (idx === -1) {
        if (!upsert) return null;
        // Build the inserted doc from the filter's equality fields, then apply
        // the update (with $setOnInsert active).
        const base = {};
        for (const [k, v] of Object.entries(filter)) {
          // Only copy plain-equality fields into the new doc (skip operator conds).
          if (!(v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).some((kk) => kk.startsWith("$")))) {
            base[k] = v;
          }
        }
        applyUpdate(base, update, true);
        docs.push(base);
        await this._writeAll(docs);
        // Mongoose returns null for the pre-image of an upsert-insert when new:false.
        return returnNew ? clone(base) : null;
      }

      const before = clone(docs[idx]);
      applyUpdate(docs[idx], update, false);
      const after = clone(docs[idx]);
      await this._writeAll(docs);
      return returnNew ? after : before;
    });
  }

  async updateOne(filter, update, options = {}) {
    const { upsert = false } = options;
    return withLock(this.file, async () => {
      const docs = await this._readAll();
      const idx = docs.findIndex((d) => matchesFilter(d, filter));
      if (idx === -1) {
        if (!upsert) return { matchedCount: 0, modifiedCount: 0 };
        const base = {};
        for (const [k, v] of Object.entries(filter)) {
          if (!(v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).some((kk) => kk.startsWith("$")))) {
            base[k] = v;
          }
        }
        applyUpdate(base, update, true);
        docs.push(base);
        await this._writeAll(docs);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      applyUpdate(docs[idx], update, false);
      await this._writeAll(docs);
      return { matchedCount: 1, modifiedCount: 1 };
    });
  }

  async findOneAndDelete(filter) {
    return withLock(this.file, async () => {
      const docs = await this._readAll();
      const idx = docs.findIndex((d) => matchesFilter(d, filter));
      if (idx === -1) return null;
      const [removed] = docs.splice(idx, 1);
      await this._writeAll(docs);
      return clone(removed);
    });
  }

  async deleteMany(filter = {}) {
    return withLock(this.file, async () => {
      const docs = await this._readAll();
      const kept = docs.filter((d) => !matchesFilter(d, filter));
      const deletedCount = docs.length - kept.length;
      await this._writeAll(kept);
      return { deletedCount };
    });
  }
}

// One Collection instance per name (so locks are shared across all callers).
const collections = new Map();
const getCollection = (name) => {
  if (!collections.has(name)) collections.set(name, new Collection(name));
  return collections.get(name);
};

module.exports = { getCollection, DATA_ROOT, Collection };
