// Installs packages that updates added, before the bot starts.
//
// Copying new files over an older bot folder doesn't install new packages, and
// `npm install` only installs what package.json lists — so an old package.json
// means e.g. tesseract.js (the receipt reader) is never installed. This checks
// each needed package and installs the missing ones by name.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const NEEDED = { "tesseract.js": "^5.1.1" };
const ROOT = __dirname;

const installed = (name) => fs.existsSync(path.join(ROOT, "node_modules", name, "package.json"));

function ensurePackages() {
  const missing = Object.keys(NEEDED).filter((n) => !installed(n));
  if (missing.length) {
    console.log(`[*] Installing missing package(s): ${missing.join(", ")} — this takes a minute, only once…`);
    const specs = missing.map((n) => `${n}@${NEEDED[n]}`);
    // Through the shell so "npm" resolves to npm.cmd on Windows (specs are fixed above).
    spawnSync(`npm install --no-audit --no-fund ${specs.join(" ")}`, { cwd: ROOT, stdio: "inherit", shell: true });
    const still = missing.filter((n) => !installed(n));
    if (still.length) {
      console.error(`[X] Couldn't install ${still.join(", ")}. Check the internet connection, then run in this folder:`);
      console.error(`      npm install ${still.map((n) => `${n}@${NEEDED[n]}`).join(" ")}`);
      console.error("    Until then GCash receipts can't be read and every top-up goes to staff for manual approval.");
    } else {
      console.log("[OK] Packages installed.");
    }
  }

  const lang = path.join(ROOT, "vendor", "tessdata", "eng.traineddata");
  if (!fs.existsSync(lang)) {
    console.error("[X] Missing vendor\\tessdata\\eng.traineddata (the receipt reader's language file).");
    console.error("    Copy the vendor folder from the update into this folder. Until then top-ups go to manual approval.");
  }
}

module.exports = ensurePackages;
if (require.main === module) ensurePackages();
