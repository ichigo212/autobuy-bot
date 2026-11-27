const crypto = require("crypto");

// Format a raw recovery key for display: grouped for readability, e.g.
// "RK-AB12-CD34-EF56-GH78". The dashes are cosmetic and stripped on redemption.
const generateRecoveryKey = () => {
  const raw = crypto.randomBytes(10).toString("hex").toUpperCase(); // 20 hex chars
  const groups = raw.match(/.{1,4}/g) || [raw];
  return `RK-${groups.join("-")}`;
};

// Normalise a key for hashing/lookup: uppercase, strip spaces and dashes, so
// "rk-ab12 cd34" and "RKAB12CD34" match the same stored hash.
const normalizeKey = (key) => (key || "").toUpperCase().replace(/[\s-]/g, "");

const hashKey = (key) =>
  crypto.createHash("sha256").update(normalizeKey(key)).digest("hex");

module.exports = { generateRecoveryKey, normalizeKey, hashKey };
