// Local launcher: runs a real mongod as a normal persistent process so all data
// (balances, stock, config, …) survives restarts, then starts the bot unchanged.
//
// Why not MongoMemoryServer? It's built for ephemeral tests — it hard-kills
// mongod without a clean WiredTiger checkpoint, so a fixed dbPath does NOT reload
// across restarts (the balances kept "resetting"). Instead we reuse the mongod
// binary that mongodb-memory-server already downloaded, point it at a persistent
// ./data/db folder, and shut it down GRACEFULLY (admin { shutdown: 1 }) so the
// catalog is checkpointed and the data is there next launch.
//
// The original Atlas cluster in .env no longer resolves (DNS ENOTFOUND), which is
// why we run locally at all.
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
// Install packages added by updates (e.g. the receipt reader) before anything loads.
require("./ensure-packages")();
const { MongoBinary } = require("mongodb-memory-server-core/lib/util/MongoBinary");
const { MongoClient } = require("mongodb");

const DB_PATH = path.join(__dirname, "data", "db");
const PORT = Number(process.env.LOCAL_MONGO_PORT) || 47017;
const URI = `mongodb://127.0.0.1:${PORT}/growstore`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Start mongod and wait until it accepts connections.
async function startMongod() {
  const bin = await MongoBinary.getPath({});
  console.log(`Starting local MongoDB (${path.basename(bin)}) on port ${PORT}…`);

  const proc = spawn(
    bin,
    ["--dbpath", DB_PATH, "--port", String(PORT), "--bind_ip", "127.0.0.1"],
    { stdio: "ignore" }
  );
  proc.on("error", (err) => {
    console.error("Failed to launch mongod:", err);
    process.exit(1);
  });

  for (let i = 0; i < 60; i++) {
    try {
      const c = new MongoClient(URI, { serverSelectionTimeoutMS: 500 });
      await c.connect();
      await c.close();
      return proc;
    } catch {
      await wait(250);
    }
  }
  throw new Error("mongod did not become ready in time.");
}

// Gracefully shut mongod down so WiredTiger checkpoints and data persists.
async function stopMongod() {
  try {
    const c = new MongoClient(URI, { serverSelectionTimeoutMS: 1000 });
    await c.connect();
    try {
      await c.db("admin").command({ shutdown: 1 });
    } catch {
      // The shutdown command intentionally drops the connection — expected.
    }
    try { await c.close(); } catch {}
  } catch {
    // If we can't connect, mongod is already gone.
  }
  await wait(500);
}

(async () => {
  fs.mkdirSync(DB_PATH, { recursive: true });
  await startMongod();
  console.log(`Local MongoDB ready at ${URI} (data persists in ${DB_PATH})`);

  // Set before requiring the bot: dotenv/config won't override an existing env
  // var, so this wins over the dead Atlas URI in .env.
  process.env.MONGODB_URI = URI;

  // Boot the bot exactly as `node src/index.js` would.
  require("./src/index.js");

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nShutting down — checkpointing database so your data is saved…");
    await stopMongod();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
})();
