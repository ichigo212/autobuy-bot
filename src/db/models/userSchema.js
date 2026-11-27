// Balances are now FILE-BASED so they persist no matter what happens to MongoDB.
//
// This module keeps the exact same method surface the rest of the bot already
// uses on the old Mongoose model (findOne, findOneAndUpdate with $inc/$set/
// $setOnInsert + upsert/new, find().sort().limit(), updateOne, create,
// countDocuments, deleteMany), so NO call site needed to change. Under the hood
// it's a JSON file at data/store/user-data.json with per-file locking, so the
// atomic conditional debit in utils/purchase.js (userBalance:{$gte:total}) stays
// race-safe.
//
// An account is keyed by (guildId, userId); userBalance defaults to 0.
const { getCollection } = require("../fileStore");

module.exports = getCollection("user-data");
