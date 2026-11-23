// What CCF has committed to its database (process-split plan, step 6), read the way the export command reads it:
// read-only, next to a running core if need be.
import fs from "node:fs";
import path from "node:path";
import { exportFiles, openDatabase } from "../../../packages/core/src/storage-schema.js";

export async function storedState(dataDir) {
  const dbPath = path.join(dataDir, "ccf.sqlite");
  if (!fs.existsSync(dbPath)) return null;
  const db = await openDatabase(dbPath, { readOnly: true });
  try { return exportFiles(db); } finally { db.close(); }
}
