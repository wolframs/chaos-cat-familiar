import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// On Windows a rename onto a file fails with EPERM/EACCES/EBUSY while another process holds the target open
// without delete sharing: a PowerShell reader of settings.json (the companion launcher polls it during CCF
// startup) or the endpoint scanner looking at the previous write. Seen 2026-11-05 as a 503 from
// /companion/open right after start. Such holds last milliseconds, so retry briefly before failing.
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200];
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

export function renameWithRetry(fsImpl, source, destination, delays = RENAME_RETRY_DELAYS_MS) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fsImpl.renameSync(source, destination);
    } catch (error) {
      if (attempt >= delays.length || !TRANSIENT_RENAME_CODES.has(error?.code)) throw error;
      Atomics.wait(sleepCell, 0, 0, delays[attempt]);
    }
  }
}

// Keep the temporary file on the destination volume so replacement is atomic.
export function writeJsonAtomic(filePath, value, { fsImpl = fs, renameRetryDelays } = {}) {
  const json = JSON.stringify(value, null, 2);
  const directory = path.dirname(filePath);
  fsImpl.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let descriptor;
  let temporaryCreated = false;
  try {
    descriptor = fsImpl.openSync(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    fsImpl.writeFileSync(descriptor, json, "utf8");
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    renameWithRetry(fsImpl, temporaryPath, filePath, renameRetryDelays);
    temporaryCreated = false;
  } finally {
    try {
      if (descriptor !== undefined) {
        fsImpl.closeSync(descriptor);
      }
    } finally {
      if (temporaryCreated) fsImpl.rmSync(temporaryPath, { force: true });
    }
  }
}

// The slow part of writeJsonAtomic (create, write, fsync, close) off the calling thread. Returns the finished
// temporary file on the destination volume; the caller renames it into place (or removes it).
export async function writeJsonTemporaryAsync(filePath, json, { fsImpl = fs } = {}) {
  const directory = path.dirname(filePath);
  await fsImpl.promises.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fsImpl.promises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(json, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    return temporaryPath;
  } catch (error) {
    try { await handle?.close(); } catch { /* The write error is the one to report. */ }
    await fsImpl.promises.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

const sleepAsync = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The same retries without blocking a thread (process-split plan, step 6: no rename retry blocks an event loop).
export async function renameWithRetryAsync(source, destination, { fsp = fs.promises, delays = RENAME_RETRY_DELAYS_MS,
  sleep = sleepAsync } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fsp.rename(source, destination);
    } catch (error) {
      if (attempt >= delays.length || !TRANSIENT_RENAME_CODES.has(error?.code)) throw error;
      await sleep(delays[attempt]);
    }
  }
}

// writeJsonAtomic without blocking: temporary file on the destination volume, fsync, rename with async retries.
export async function writeJsonAtomicAsync(filePath, value, { fsp = fs.promises, renameRetryDelays, sleep } = {}) {
  const temporaryPath = await writeJsonTemporaryAsync(filePath, JSON.stringify(value, null, 2), { fsImpl: { promises: fsp } });
  try {
    await renameWithRetryAsync(temporaryPath, filePath, { fsp, delays: renameRetryDelays, sleep });
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

// loadJsonWithRecovery without blocking: a file that does not parse is moved aside with a note, defaults load.
export async function loadJsonWithRecoveryAsync(filePath, defaults, { fsp = fs.promises, logger = console } = {}) {
  let raw;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(defaults);
    throw error;
  }
  try {
    return { ...structuredClone(defaults), ...JSON.parse(raw) };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const quarantinePath = `${filePath}.corrupt-${Date.now()}-${randomUUID()}`;
    const notePath = `${quarantinePath}.recovery.txt`;
    await fsp.writeFile(notePath, [
      `Retained corrupt CCF JSON from: ${filePath}`,
      `Quarantine: ${quarantinePath}`,
      `Reason: JSON parsing failed (${error.message}). CCF loaded defaults.`,
      "Keep this data so settings or session history can be recovered.",
      "A future agent may delete this quarantine and note after recovering useful data",
      "or verifying that replacement settings/history supersede it and no recovery is needed.",
      ""
    ].join("\n"), { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await renameWithRetryAsync(filePath, quarantinePath, { fsp });
    } catch (renameError) {
      await fsp.rm(notePath, { force: true }).catch(() => {});
      throw renameError;
    }
    logger?.warn?.("persistence", `Corrupt CCF JSON moved to ${quarantinePath}; loading defaults.`, {
      filePath, quarantinePath, error: error.message
    });
    return structuredClone(defaults);
  }
}

export function loadJsonWithRecovery(filePath, defaults, { fsImpl = fs, logger = console } = {}) {
  let raw;
  try {
    raw = fsImpl.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(defaults);
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const quarantinePath = `${filePath}.corrupt-${Date.now()}-${randomUUID()}`;
    const notePath = `${quarantinePath}.recovery.txt`;
    fsImpl.writeFileSync(notePath, [
      `Retained corrupt CCF JSON from: ${filePath}`,
      `Quarantine: ${quarantinePath}`,
      `Reason: JSON parsing failed (${error.message}). CCF loaded defaults.`,
      "Keep this data so settings or session history can be recovered.",
      "A future agent may delete this quarantine and note after recovering useful data",
      "or verifying that replacement settings/history supersede it and no recovery is needed.",
      ""
    ].join("\n"), { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      fsImpl.renameSync(filePath, quarantinePath);
    } catch (renameError) {
      fsImpl.rmSync(notePath, { force: true });
      throw renameError;
    }
    logger.warn("persistence", `Corrupt CCF JSON moved to ${quarantinePath}; loading defaults.`, {
      filePath, quarantinePath, error: error.message
    });
    return structuredClone(defaults);
  }
  return { ...structuredClone(defaults), ...parsed };
}
