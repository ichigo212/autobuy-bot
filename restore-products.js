// One-time restore of the products that existed before the 2026-11-18 reset,
// with their keys (serials). Keys that were already sold are left out. Sales,
// analytics, balances and top-ups are NOT touched. Running it again is safe:
// products that exist are kept and only missing keys are added back.
//
// Run: double-click restore-products.bat (close the bot first).
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { MongoClient } = require("mongodb");

// Products saved in backups/backup-2026-11-18-before-reset (mongo-json/growstore.store-datas.json).
const BACKUP = [
  {
    "guildId": "1457737201252307057",
    "products": [
      {
        "productName": "2x 1 Month Server boost",
        "productCode": "1",
        "productPrice": 20,
        "cost": 19,
        "deliveryMessage": "Thankyou for buying Create a tiket if theres any failed boost or concern",
        "deliveryButtons": [
          {
            "label": "Redeem",
            "url": "https://boostbot.online/api/redeem-order/1457737201252307057"
          }
        ]
      },
      {
        "productName": "4x 1 Month Server Boost",
        "productCode": "2",
        "productPrice": 40,
        "cost": 38,
        "deliveryMessage": "Thankyou for buying click the redeem button create a ticket if theres any concern or failed boost \n\nif u click the redeem button choose customer",
        "deliveryButtons": [
          {
            "label": "Redeem",
            "url": "https://boostbot.online/api/redeem-order/1457737201252307057"
          }
        ]
      },
      {
        "productName": "6x 1 Month Server Boost",
        "productCode": "3",
        "productPrice": 60,
        "cost": 57,
        "deliveryMessage": "Thankyou for buying click the redeem button create a ticket if theres any concern or failed boost \n\nif u click the redeem button choose customer",
        "deliveryButtons": [
          {
            "label": "Redeem",
            "url": "https://boostbot.online/api/redeem-order/1457737201252307057"
          }
        ]
      },
      {
        "productName": "8x 1 Month Server Boost",
        "productCode": "4",
        "productPrice": 80,
        "cost": 76,
        "deliveryMessage": "Thankyou for buying click the redeem button create a ticket if theres any concern or failed boost \n\nif u click the redeem button choose customer",
        "deliveryButtons": [
          {
            "label": "Redeem",
            "url": "https://boostbot.online/api/redeem-order/1457737201252307057"
          }
        ]
      },
      {
        "productName": "10x 1 Month Server Boost",
        "productCode": "5",
        "productPrice": 100,
        "cost": 95,
        "deliveryMessage": "Thankyou for buying click the redeem button create a ticket if theres any concern or failed boost \n\nif u click the redeem button choose customer",
        "deliveryButtons": [
          {
            "label": "Redeem",
            "url": "https://boostbot.online/api/redeem-order/1457737201252307057"
          }
        ]
      },
      {
        "productName": "12x 1 Month Server Boost",
        "productCode": "6",
        "productPrice": 120,
        "cost": 114,
        "deliveryMessage": "Thankyou for buying click the redeem button create a ticket if theres any concern or failed boost \n\nif u click the redeem button choose customer",
        "deliveryButtons": [
          {
            "label": "Redeem",
            "url": "https://boostbot.online/api/redeem-order/1457737201252307057"
          }
        ]
      },
      {
        "productName": "14x 1 Month Server Boost",
        "productCode": "7",
        "productPrice": 140,
        "cost": 133,
        "deliveryMessage": "Thankyou for buying click the redeem button create a ticket if theres any concern or failed boost \n\nif u click the redeem button choose customer",
        "deliveryButtons": [
          {
            "label": "Redeem",
            "url": "https://boostbot.online/api/redeem-order/1457737201252307057"
          }
        ]
      },
      {
        "productName": "2x 3m serverboost",
        "productCode": "8",
        "productPrice": 70,
        "cost": 58.78,
        "deliveryMessage": "Thankyou for buying Create a tiket if theres any failed boost or concern",
        "deliveryButtons": [
          {
            "label": "Redeem",
            "url": "https://boostbot.online/api/redeem-order/1457737201252307057"
          }
        ]
      },
      {
        "productName": "4x 3m serverboost",
        "productCode": "9",
        "productPrice": 140,
        "cost": 117.56,
        "deliveryMessage": "Thankyou for buying Create a tiket if theres any failed boost or concern",
        "deliveryButtons": [
          {
            "label": "Redeem",
            "url": "https://boostbot.online/api/redeem-order/1457737201252307057"
          }
        ]
      },
      {
        "productName": "6x 3m serverboost",
        "productCode": "10",
        "productPrice": 210,
        "cost": 176.34,
        "deliveryMessage": "Thankyou for buying Create a tiket if theres any failed boost or concern",
        "deliveryButtons": [
          {
            "label": "Redeem",
            "url": "https://boostbot.online/api/redeem-order/1457737201252307057"
          }
        ]
      },
      {
        "productName": "8x 3m serverboost",
        "productCode": "11",
        "productPrice": 280,
        "cost": 235.12,
        "deliveryMessage": "Thankyou for buying Create a tiket if theres any failed boost or concern",
        "deliveryButtons": [
          {
            "label": "Redeem",
            "url": "https://boostbot.online/api/redeem-order/1457737201252307057"
          }
        ]
      },
      {
        "productName": "10x 3m serverboost",
        "productCode": "12",
        "productPrice": 350,
        "cost": 293.9,
        "deliveryMessage": "Thankyou for buying Create a tiket if theres any failed boost or concern",
        "deliveryButtons": [
          {
            "label": "Redeem",
            "url": "https://boostbot.online/api/redeem-order/1457737201252307057"
          }
        ]
      },
      {
        "productName": "12x 3m serverboost",
        "productCode": "13",
        "productPrice": 420,
        "cost": 352.68,
        "deliveryMessage": "Thankyou for buying Create a tiket if theres any failed boost or concern",
        "deliveryButtons": [
          {
            "label": "Redeem",
            "url": "https://boostbot.online/api/redeem-order/1457737201252307057"
          }
        ]
      },
      {
        "productName": "14x 3m serverboost",
        "productCode": "14",
        "productPrice": 490,
        "cost": 411.46,
        "deliveryMessage": "Thankyou for buying Create a tiket if theres any failed boost or concern",
        "deliveryButtons": [
          {
            "label": "Redeem",
            "url": "https://boostbot.online/api/redeem-order/1457737201252307057"
          }
        ]
      }
    ]
  }
];

const ROOT = __dirname;
const DB_PATH = path.join(ROOT, "data", "db");
const PORT = Number(process.env.LOCAL_MONGO_PORT) || 47017;
const URI = `mongodb://127.0.0.1:${PORT}/growstore`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const tryConnect = async () => {
  const c = new MongoClient(URI, { serverSelectionTimeoutMS: 800 });
  try { await c.connect(); return c; } catch { try { await c.close(); } catch {} return null; }
};

async function startMongod() {
  const { MongoBinary } = require("mongodb-memory-server-core/lib/util/MongoBinary");
  const bin = await MongoBinary.getPath({});
  fs.mkdirSync(DB_PATH, { recursive: true });
  const proc = spawn(bin, ["--dbpath", DB_PATH, "--port", String(PORT), "--bind_ip", "127.0.0.1"], { stdio: "ignore" });
  proc.on("error", (e) => { console.error("Couldn't start the database:", e.message); process.exit(1); });
  for (let i = 0; i < 80; i++) { const c = await tryConnect(); if (c) return c; await wait(250); }
  throw new Error("The database did not start. Is the bot still starting up? Close it and try again.");
}

async function stopMongod(client) {
  try { await client.db("admin").command({ shutdown: 1 }); } catch {}
  try { await client.close(); } catch {}
  await wait(800);
}

const fileStock = require("./src/utils/fileStock");

// Keys (serials) for a product: restore-keys/<server>/<code>.txt, or straight
// from the backup folder if that's here.
const KEY_DIRS = [path.join(ROOT, "restore-keys"), path.join(ROOT, "backups", "backup-2026-11-18-before-reset", "code-snapshot", "src", "stock")];
const backupKeys = (guildId, code) => {
  for (const dir of KEY_DIRS) {
    const f = path.join(dir, String(guildId), `${code}.txt`);
    if (fs.existsSync(f)) return fileStock.parseCodes(fs.readFileSync(f, "utf8"));
  }
  return null;
};

// Every key ever delivered: sales in the bot now + the sales in the backup.
const soldKeys = async (db) => {
  const sold = new Set();
  const addSale = (s) => [].concat(s.deliveredCodes || [], s.deliveredCode || []).forEach((k) => k && sold.add(String(k).trim()));
  for await (const s of db.collection("sale-datas").find({}, { projection: { deliveredCodes: 1, deliveredCode: 1 } })) addSale(s);
  const old = path.join(ROOT, "backups", "backup-2026-11-18-before-reset", "mongo-json", "growstore.sale-datas.json");
  if (fs.existsSync(old)) JSON.parse(fs.readFileSync(old, "utf8")).forEach(addSale);
  return sold;
};

(async () => {
  if (await tryConnect()) {
    console.log("The bot is running. Close the bot window first (or press Ctrl+C in it), then run this again.");
    process.exit(1);
  }
  console.log("Starting the local database…");
  const client = await startMongod();
  const db = client.db();
  const col = db.collection("store-datas");
  const sold = await soldKeys(db);
  let added = 0, keysAdded = 0, soldSkipped = 0;

  for (const g of BACKUP) {
    const doc = await col.findOne({ guildId: g.guildId });
    const have = new Set((doc?.store || []).map((p) => String(p.productCode)));
    for (const p of g.products) {
      const all = backupKeys(g.guildId, p.productCode);
      if (!all) console.log(`  ! no key file found for ${p.productCode} — product restored without keys`);
      const keys = [...new Set(all || [])].filter((k) => !sold.has(k));
      soldSkipped += (all || []).length - keys.length;

      // Keep any keys already in the product, add back the missing ones.
      const current = await fileStock.readCodes(g.guildId, p.productCode);
      const inFile = new Set(current);
      const missing = keys.filter((k) => !inFile.has(k));
      const finalKeys = [...current, ...missing];
      await fileStock.replaceCodes(g.guildId, p.productCode, finalKeys);
      keysAdded += missing.length;

      if (!have.has(p.productCode)) {
        await col.updateOne(
          { guildId: g.guildId },
          { $setOnInsert: { guildId: g.guildId }, $push: { store: { ...p, productStock: finalKeys.length, createdAt: new Date() } } },
          { upsert: true }
        );
        added++;
        console.log(`  added    ${p.productCode} · ${p.productName} · ${finalKeys.length} keys`);
      } else {
        await col.updateOne({ guildId: g.guildId, "store.productCode": p.productCode }, { $set: { "store.$.productStock": finalKeys.length } });
        console.log(`  restocked ${p.productCode} · ${p.productName} · +${missing.length} keys → ${finalKeys.length} in stock`);
      }
    }
  }

  await stopMongod(client);
  console.log(`\nDone: ${added} product(s) added, ${keysAdded} key(s) put back${soldSkipped ? `, ${soldSkipped} already-sold key(s) left out` : ""}.`);
  console.log("Sales/analytics were not touched. Start the bot with start.bat — the store and live stock update on start (or run /setupstore).");
  process.exit(0);
})().catch((e) => { console.error("Restore failed:", e.message); process.exit(1); });
