const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Crash-safe file write: write to a temp file in the same folder, then rename it
// over the target. A crash or power loss mid-write leaves the old file intact
// instead of a half-written (or empty) one.
//
// On Windows, antivirus / OneDrive / an open editor can briefly lock the target,
// making rename fail with EPERM/EBUSY/EACCES — retry a few times before giving up.
const writeFileAtomic = async (filePath, data) => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fsp.writeFile(tmp, data, "utf8");

  let lastErr;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await fsp.rename(tmp, filePath);
      return;
    } catch (err) {
      lastErr = err;
      if (!["EPERM", "EBUSY", "EACCES"].includes(err.code)) break;
      await sleep(25 * (attempt + 1));
    }
  }
  await fsp.unlink(tmp).catch(() => {});
  throw lastErr;
};

module.exports = { writeFileAtomic };
