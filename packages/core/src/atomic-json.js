import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Keep the temporary file on the destination volume so replacement is atomic.
export function writeJsonAtomic(filePath, value, { fsImpl = fs } = {}) {
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
    fsImpl.renameSync(temporaryPath, filePath);
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
