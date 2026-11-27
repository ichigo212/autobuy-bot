// A pending GCash top-up request awaiting staff review.
//
// FILE-BASED (same store engine as balances/keys) so requests survive restarts
// and don't depend on MongoDB. The status field is flipped atomically from
// "pending" → "approved"/"declined" under the file lock, so two staff clicking
// Approve/Decline at the same instant can never double-credit a balance.
//
// Keyed by requestId (a short random id embedded in the review message's button
// customIds). guildId+userId identify whose balance to credit; amount is the
// balance to add on approval.
const { getCollection } = require("../fileStore");

module.exports = getCollection("topup-requests");
