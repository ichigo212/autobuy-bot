// Reads GCash top-up receipts on this machine (no receipt leaves it) and judges them.
// Ported from the deco site's receipt-check.js, without its trusted-buyer requirements.
//
//   parseReceipt(text)   pure: the fields we can read from the OCR text of a screenshot
//   judge(input)         pure: rejected | check | ok | auto, with the reasons staff see
//   createReceiptReader  one local Tesseract worker, a queue and a timeout
//   getReader()          the shared reader used by /topup
//
// A screenshot can be faked, so nothing here proves money arrived. The judge only rejects what our own
// records prove (a reused Ref No. or image), sends anything uncertain to a human, and auto-approves
// only fully matching receipts under the owner's limit. Staff can undo an auto-approval.

const path = require("path");

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const PHONE = /\+?63\s*9\d{2}\s*\d{3}\s*\d{4}|\b09\d{9}\b/g;
const php = (centavos) => `₱${(centavos / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Epoch ms for a Philippine (UTC+8) wall-clock time. month is 1-12. */
const manilaTime = (y, month, d, h, min) => Date.UTC(y, month - 1, d, h - 8, min);

const centavos = (s) => Math.round(Number(String(s).replace(/,/g, "")) * 100);
const last10 = (s) => String(s || "").replace(/\D/g, "").slice(-10);

function gcashDate(flat) {
  const m = flat.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),\s*(\d{4}),?\s+(\d{1,2}):(\d{2})\s*([AP])\.?M/i);
  if (!m) return null;
  let h = Number(m[4]) % 12;
  if (m[6].toUpperCase() === "P") h += 12;
  return manilaTime(Number(m[3]), MONTHS[m[1].toLowerCase()] + 1, Number(m[2]), h, Number(m[5]));
}

function bankDate(flat) {
  const m = flat.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4}),?\s+(\d{1,2}):(\d{2})/i);
  if (!m) return gcashDate(flat);
  return manilaTime(Number(m[3]), MONTHS[m[2].toLowerCase()] + 1, Number(m[1]), Number(m[4]), Number(m[5]));
}

/**
 * Fields read from a receipt's OCR text. amount in centavos, ref digits only, numbers = last 10 digits
 * of every mobile number on it, sentAt epoch ms. layout is null when it isn't a receipt we know.
 */
function parseReceipt(text) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  // Mobile numbers, however GCash or the reader grouped the digits ("+63 923 …", "092 348 686 96").
  const joined = flat.replace(/(?<=\d)[ -](?=\d)/g, "");
  const numbers = [...new Set((joined.match(/(?:\+?63|0)9\d{9}/g) || []).map(last10))];
  const none = { layout: null, amount: null, ref: null, numbers, sentAt: null };

  // InstaPay transfer from a bank app (MariBank and similar) to the shop's GCash.
  if (/Reference Number/i.test(flat) && /Transfer Amount|Total Amount\s*PHP|insta\s*[pf]ay/i.test(flat)) {
    const amt = flat.match(/(?:Transfer Amount|Total Amount)\s*PHP\s*([0-9][0-9,]*\.\d{2})/i);
    const ref = flat.match(/Reference Number\s*:?\s*([0-9]{6,20})\b/i);
    return { layout: "instapay", amount: amt ? centavos(amt[1]) : null, ref: ref ? ref[1] : null, numbers, sentAt: bankDate(flat) };
  }

  // GCash Express Send. The grey "Ref No." label is often lost, so look for the 13-digit number itself
  // (printed whole or as 4-3-6), after removing phone numbers and amounts so they can't merge into it.
  const looksGcash = /Sent via GCash|Express Send|Total Amount Sent/i.test(flat);
  const amt = flat.match(/(?:^|\s)Amount\s+([0-9][0-9,]*\.\d{2})/i) || flat.match(/Total Amount Sent\s+\S?\s*([0-9][0-9,]*\.\d{2})/i);
  let ref = null;
  const clean = flat.replace(PHONE, " | ");
  for (const c of clean.match(/(?<![0-9+])(?<![0-9][.,])\d[\d ]{11,16}\d(?![0-9])/g) || []) {
    const d = c.replace(/ /g, "");
    if (d.length === 13) {
      ref = d;
      break;
    }
  }
  if (!looksGcash || (!amt && !ref)) return none;
  return { layout: "gcash", amount: amt ? centavos(amt[1]) : null, ref, numbers, sentAt: gcashDate(flat) };
}

/**
 * The verdict for one receipt. Input:
 *   amount       requested, centavos        typedRef  digits the buyer typed (or null)
 *   read         parseReceipt() or null     readError why the reader failed, if it did
 *   ownerNumber  the shop's GCash number    now, maxAgeMs
 *   refUse       { typed, read }: status of another top-up already holding that Ref No. (or null)
 *   imageUse     status of another top-up with the same image (or null)
 *   auto         { on, max } max in centavos
 * Verdicts: rejected (reused Ref No./image — certain), check (something doesn't match — staff),
 *           ok (everything matches but auto-approve is off / over the limit — staff), auto (credit now).
 */
function judge(x) {
  const used = (s) => s === "approved" || s === "pending" || s === "processing";
  const bad = (s) => s === "declined" || s === "reversed";
  // Certain from our own records: the receipt was already used.
  if (used(x.refUse.typed)) return { verdict: "rejected", reasons: [`This Ref No. was already used on another top-up (${x.refUse.typed}).`] };
  if (used(x.refUse.read)) return { verdict: "rejected", reasons: [`The Ref No. on this receipt was already used on another top-up (${x.refUse.read}).`] };
  if (used(x.imageUse)) return { verdict: "rejected", reasons: [`This exact screenshot was already sent for another top-up (${x.imageUse}).`] };

  const r = x.read;
  const reasons = [];
  if (!r) reasons.push(`Couldn't read the receipt${x.readError ? ` (${x.readError})` : ""}.`);
  else if (!r.layout) reasons.push("Receipt not recognised (unknown bank, new layout, or not a receipt).");
  else {
    if (r.amount === null) reasons.push("Couldn't read the amount.");
    else if (r.amount !== x.amount) reasons.push(`Receipt shows ${php(r.amount)}, requested ${php(x.amount)}.`);
    if (!r.ref) reasons.push("Couldn't read the Ref No.");
    else if (x.typedRef && r.ref !== x.typedRef) reasons.push(`Ref No. on the receipt (${r.ref}) differs from the one typed (${x.typedRef}).`);
    const owner = last10(x.ownerNumber);
    if (owner.length !== 10) reasons.push("The shop's GCash number isn't set (GCASH_NUMBER in .env), so the recipient can't be checked.");
    else if (!r.numbers.includes(owner)) reasons.push("Not sent to the shop's GCash number.");
    if (r.sentAt === null) reasons.push("Couldn't read the date.");
    else if (r.sentAt > x.now + 10 * 60000) reasons.push("The receipt date is in the future.");
    else if (x.now - r.sentAt > x.maxAgeMs) reasons.push(`The receipt is ${Math.floor((x.now - r.sentAt) / 60000)} minutes old (limit ${Math.round(x.maxAgeMs / 60000)}).`);
  }
  if (bad(x.refUse.typed) || bad(x.refUse.read)) reasons.push("This Ref No. was on a top-up that was declined or reversed before.");
  if (bad(x.imageUse)) reasons.push("This screenshot was on a top-up that was declined or reversed before.");
  if (reasons.length) return { verdict: "check", reasons };

  const why = [];
  if (!x.auto.on) why.push("Auto-approve is off.");
  if (x.amount > x.auto.max) why.push(`Over the ${php(x.auto.max)} auto-approve limit.`);
  return why.length ? { verdict: "ok", reasons: why } : { verdict: "auto", reasons: [] };
}

/** The image type from its first bytes (png, jpg, webp, gif), or null: never trust the file name. */
function imageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (buf.toString("latin1", 0, 4) === "GIF8") return "gif";
  return null;
}

const LANG_PATH = path.join(__dirname, "..", "..", "vendor", "tessdata");

async function tesseractWorker() {
  const { createWorker } = require("tesseract.js");
  // Without errorHandler, tesseract.js re-throws a bad image's error outside any promise, which would
  // crash the whole bot. With it, recognize() just rejects.
  return createWorker("eng", 1, { langPath: LANG_PATH, gzip: false, cacheMethod: "none", errorHandler: () => {} });
}

/**
 * One OCR worker, used one receipt at a time. read(buffer) resolves to the text or rejects (timeout,
 * broken image, missing language file, too many receipts waiting). A worker that timed out or failed is
 * thrown away and shut down, even if it only finishes starting later.
 */
function createReceiptReader({ timeoutMs = 20000, maxQueue = 10, createWorker = tesseractWorker, log = console } = {}) {
  let current = null; // promise of the worker in use
  let queue = Promise.resolve();
  let waiting = 0;

  const later = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
  async function kill(w) {
    try {
      await Promise.race([w.terminate(), later(3000)]);
    } catch {
      /* already gone */
    }
  }
  function worker() {
    if (!current) {
      const p = createWorker();
      current = p;
      p.catch(() => {
        if (current === p) current = null;
      });
    }
    return current;
  }
  function discard(p) {
    if (current === p) current = null;
    p.then(kill, () => {});
  }

  async function once(buf) {
    const p = worker();
    const work = p.then((w) => w.recognize(buf));
    let timer;
    try {
      const out = await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("the receipt reader timed out")), timeoutMs);
        }),
      ]);
      return String(out?.data?.text || "");
    } catch (e) {
      work.catch(() => {}); // a late failure of the abandoned read must not crash the process
      discard(p);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function read(buf) {
    if (!imageType(buf)) return Promise.reject(new Error("not a PNG, JPG, WEBP or GIF image"));
    if (waiting >= maxQueue) return Promise.reject(new Error("the receipt reader is busy"));
    waiting++;
    const run = queue.then(() => once(buf)).finally(() => {
      waiting--;
    });
    queue = run.catch((e) => log.warn?.(`Receipt reader: ${e.message}`));
    return run;
  }

  async function close() {
    await queue.catch(() => {});
    const p = current;
    current = null;
    if (p) await p.then(kill, () => {});
  }

  return { read, close };
}

let shared = null;
const getReader = () => (shared ||= createReceiptReader());
const setReader = (r) => {
  shared = r;
};

module.exports = { parseReceipt, judge, createReceiptReader, getReader, setReader, imageType, manilaTime, last10, php };
