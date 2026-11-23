#!/usr/bin/env node
// Exports CCF's current state from ccf.sqlite as the JSON files a CCF from before the SQLite step reads (process-split
// plan, step 6). Once SQLite has accepted writes, the state.json it imported is stale: this export, not that file, is
// the way back to an older build. Read-only on the database; safe while CCF runs (WAL).
//
//   node scripts/windows/storage-export.mjs                 -> <data>\export-<stamp>\state.json, companion-delivery.json
//   node scripts/windows/storage-export.mjs --out <folder>  -> those two files in <folder>
//   node scripts/windows/storage-export.mjs --to-json       -> state.json and companion-delivery.json in <data> itself,
//                                                              for the rollback (CCF must be closed; refuses to overwrite)
// Options: --root <data folder> (default %APPDATA%\chaos-cat-familiar), --db <file> (default <root>\ccf.sqlite), --force.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { exportFiles, openDatabase } from "../../packages/core/src/storage-schema.js";

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
// SQLite's primary codes worth another attempt: BUSY, LOCKED, IOERR, CANTOPEN. Right after CCF was hard-killed the first
// read once failed with "disk I/O error" while the WAL settled; a retry a moment later worked (review of step 6, P2).
const TRANSIENT = new Set([5, 6, 10, 14]);
const RETRY_DELAYS_MS = [250, 500, 1000, 2000];
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every table from one read transaction: a commit that lands meanwhile is either wholly in the export or not at all.
async function readSnapshot(dbPath, settings, open) {
  const database = await open(dbPath, { readOnly: true });
  try {
    database.exec("BEGIN");
    try { return exportFiles(database, { settings }); }
    finally { try { database.exec("COMMIT"); } catch { /* a read transaction has nothing to keep */ } }
  } finally { database.close(); }
}

function describe(error) {
  return `${error?.errstr ?? error?.message ?? error}, SQLite extended code ${error?.errcode ?? "unknown"}`;
}

export async function exportStorage({ root, db = null, out = null, toJson = false, force = false, open = openDatabase,
  sleep = defaultSleep, retryDelaysMs = RETRY_DELAYS_MS, log = (line) => console.error(line) } = {}) {
  if (!root) throw new Error("No CCF data folder (--root, or APPDATA).");
  const dbPath = db ?? path.join(root, "ccf.sqlite");
  if (!fs.existsSync(dbPath)) throw new Error(`No database at ${dbPath}.`);
  const target = toJson ? root : out ?? path.join(root, `export-${stamp()}`);
  const files = { state: path.join(target, "state.json"), delivery: path.join(target, "companion-delivery.json") };
  if (toJson && !force) {
    if (fs.existsSync(path.join(root, "runtime.json"))) {
      throw new Error("CCF seems to be running (runtime.json exists). Quit it first, or pass --force if it crashed.");
    }
    const existing = Object.values(files).filter((file) => fs.existsSync(file));
    if (existing.length) throw new Error(`Refusing to overwrite ${existing.join(", ")} (--force overwrites).`);
  }
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(path.join(root, "settings.json"), "utf8")); } catch { /* the state's copy is informational */ }
  let exported;
  let retries = 0;
  for (let attempt = 0; !exported; attempt++) {
    try { exported = await readSnapshot(dbPath, settings, open); }
    catch (error) {
      const transient = TRANSIENT.has(Number.isInteger(error?.errcode) ? error.errcode & 0xff : null);
      if (!transient) {
        throw new Error(`The database ${dbPath} could not be read (${describe(error)}). It may be damaged; CCF moves an `
          + "unreadable database aside on its next start.", { cause: error });
      }
      if (attempt >= retryDelaysMs.length) {
        throw new Error(`The database ${dbPath} could not be read after ${attempt + 1} attempts (${describe(error)}). If CCF `
          + "was just closed or killed, wait a few seconds and run the export again.", { cause: error });
      }
      log(`storage-export: attempt ${attempt + 1} failed (${describe(error)}); retrying in ${retryDelaysMs[attempt]} ms`);
      await sleep(retryDelaysMs[attempt]);
      retries += 1;
    }
  }
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(files.state, JSON.stringify(exported.state, null, 2));
  fs.writeFileSync(files.delivery, JSON.stringify(exported.delivery, null, 2));
  return { files, retries, counts: { events: exported.state.events.length, notifications: exported.state.notifications.length,
    sessions: exported.state.sessions.length, submissions: exported.delivery.submissions.length,
    inbox: exported.delivery.inbox.length } };
}

function parseArgs(argv) {
  const options = { root: process.env.APPDATA ? path.join(process.env.APPDATA, "chaos-cat-familiar") : null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") options.root = argv[++i];
    else if (arg === "--db") options.db = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--to-json") options.toJson = true;
    else if (arg === "--force") options.force = true;
    else throw new Error(`Unknown argument ${arg}.`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await exportStorage(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`storage-export: ${error.message}`);
    process.exitCode = 1;
  }
}
