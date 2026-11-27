// Recovery keys are now FILE-BASED so they persist across restarts and don't
// depend on MongoDB.
//
// Same method surface as the old Mongoose model (findOne, findOneAndUpdate with
// upsert, findOneAndDelete, create, deleteMany), so /user's "Generate recovery
// key" button and /recoverbalance use work unchanged. Stored at
// data/store/recovery-key-data.json with per-file locking.
//
// SECURITY: only a SHA-256 HASH of the key is stored, never the raw key — a data
// leak can't be used to steal balances. The raw key is shown to the user exactly
// once, at generation. A key is keyed by (guildId, userId); generating a new one
// replaces the old (upsert on that pair).
const { getCollection } = require("../fileStore");

module.exports = getCollection("recovery-key-data");
