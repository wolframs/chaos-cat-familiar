import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Claude Code keeps one ~/.claude/sessions/<pid>.json per live session with a
// `status`: busy, idle, waiting, or "shell" = the turn ended but a background
// shell still runs and will wake the session again. Background sub agents and
// workflows keep the status at "busy" instead (Claude Code 2.1.322; it sent no
// idle_prompt while agents ran). An idle_prompt from a "shell" session is not a
// session waiting on the user. The file outlives a crashed process.
export function claudeSessionsDir(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "sessions");
}

export function claudeSessionStatus(sessionId, { dir = claudeSessionsDir(), readdir = fs.readdirSync,
  readFile = fs.readFileSync } = {}) {
  if (!sessionId) return null;
  let names;
  try { names = readdir(dir); } catch { return null; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFile(path.join(dir, name), "utf8"));
      if (record?.sessionId === sessionId) return typeof record.status === "string" ? record.status : null;
    } catch {
      // A file being rewritten or gone: skip it.
    }
  }
  return null;
}

// Whether a session's transcript lies under a Claude config dir (`<configDir>/projects/<slug>/<id>.jsonl`): only such
// sessions belong to that config dir's registry. A session of WSL, of another CLAUDE_CONFIG_DIR or without a known
// transcript is in no registry this sweep reads, and is never ended by it (review 2, finding 1).
export function transcriptUnder(transcriptPath, configDir) {
  if (typeof transcriptPath !== "string" || !transcriptPath || !configDir) return false;
  const norm = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return norm(transcriptPath).startsWith(norm(path.join(configDir, "projects")) + path.sep);
}

const FILETIME_TOLERANCE = 50_000_000n;   // 5 s in 100 ns units

function filetimeOf(value) {
  try {
    const time = BigInt(String(value));
    return time >= 10n ** 16n ? time : null;   // not a Windows FILETIME: nothing to compare
  } catch { return null; }
}

// The creation times (FILETIME, BigInt) of the given processes, in one PowerShell start. A pid missing from the map:
// no such process. null for a pid: it runs, its start time could not be read. Throws when PowerShell fails.
export async function windowsProcessStartTimes(pids, { execFile = execFileAsync } = {}) {
  const list = pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  if (list.length === 0) return new Map();
  const script = `foreach ($id in @(${list.join(",")})) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; ` +
    `if ($p) { try { "$id|$($p.StartTime.ToFileTimeUtc())" } catch { "$id|?" } } }`;
  const { stdout } = await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 15000 });
  const times = new Map();
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = /^(\d+)\|(\d+|\?)$/.exec(line.trim());
    if (match) times.set(Number(match[1]), match[2] === "?" ? null : BigInt(match[2]));
  }
  return times;
}

// The session sweep's view of Claude Code's registry (<configDir>/sessions/<pid>.json, one per running session; a
// crash leaves its file behind). liveIds() returns the session ids that may still run, or null when nothing can be
// decided this round. What counts as gone must be certain; everything uncertain counts as live (review 2):
// - a file that cannot be read is tried again once; a file that stays unreadable keeps the record last read from it
//   (finding 3). A broken file whose pid does not run is ignored (a crash's leftover). A broken file whose pid runs
//   and was never read since CCF started: nobody can tell whose it is, so this round decides nothing.
// - a running pid is the session's only when the process started at the file's procStart (finding 2): a pid reused
//   after a crash is another process. Checked only for the sweep's candidates (quiet active sessions missing nowhere
//   else), batched in one PowerShell start, a match re-checked every recheckMs, a mismatch remembered.
// Asynchronous: it runs in the core's thread every minute (the core does no synchronous file work on a timer).
export class ClaudeRegistryLiveness {
  constructor({ dir = claudeSessionsDir(), fsp = fs.promises, pidAlive = processAlive,
    processStartTimes = windowsProcessStartTimes, retryMs = 250, recheckMs = 15 * 60_000, now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()) } = {}) {
    Object.assign(this, { dir, fsp, pidAlive, processStartTimes, retryMs, recheckMs, now, sleep });
    this.lastGood = new Map();   // file name -> { sessionId, pid, procStart }
    this.identity = new Map();   // `${pid}:${procStart}` -> { same, at }
  }

  async readRecord(name) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const record = JSON.parse(await this.fsp.readFile(path.join(this.dir, name), "utf8"));
        return typeof record?.sessionId === "string" ? { record } : { bad: true };
      } catch (error) {
        if (error?.code === "ENOENT") return { gone: true };
        if (attempt === 0) await this.sleep(this.retryMs);
      }
    }
    return { bad: true };
  }

  // Broken files whose pid runs: each is a crash's leftover only when it was last written before that process
  // started (the pid was reused). Anything unsure: false.
  async allStale(unknown) {
    let times;
    try { times = await this.processStartTimes([...new Set(unknown.map((item) => item.pid))]); }
    catch { return false; }
    for (const { name, pid } of unknown) {
      if (!times.has(pid)) continue;   // gone meanwhile
      const created = times.get(pid);
      if (created === null) return false;
      let written;
      try { written = (await this.fsp.stat(path.join(this.dir, name))).mtimeMs; }
      catch (error) { if (error?.code === "ENOENT") continue; return false; }
      const createdMs = Number(created / 10_000n) - 11_644_473_600_000;
      if (!(written < createdMs - 5000)) return false;
    }
    return true;
  }

  async liveIds({ candidates = null } = {}) {
    let names;
    try { names = (await this.fsp.readdir(this.dir)).filter((name) => name.endsWith(".json")); }
    catch { return null; }
    const records = [];
    const unknown = [];
    for (const name of names) {
      const read = await this.readRecord(name);
      if (read.record) {
        const { sessionId, pid, procStart } = read.record;
        this.lastGood.set(name, { sessionId, pid, procStart });
        records.push(read.record);
        continue;
      }
      if (read.gone) { this.lastGood.delete(name); continue; }
      const pid = Number.parseInt(name, 10);
      if (!this.pidAlive(pid)) continue;
      const previous = this.lastGood.get(name);
      if (previous && previous.pid === pid) records.push(previous);
      else unknown.push({ name, pid });
    }
    for (const name of [...this.lastGood.keys()]) if (!names.includes(name)) this.lastGood.delete(name);
    if (unknown.length > 0 && !(await this.allStale(unknown))) return null;

    const ids = new Set();
    const toCheck = [];
    const seen = new Set();
    for (const record of records) {
      if (!this.pidAlive(record.pid)) continue;
      const start = filetimeOf(record.procStart);
      const key = `${record.pid}:${start}`;
      seen.add(key);
      if (start === null || !candidates?.has(record.sessionId)) { ids.add(record.sessionId); continue; }
      const known = this.identity.get(key);
      if (known && !known.same) continue;
      if (known && this.now() - known.at < this.recheckMs) { ids.add(record.sessionId); continue; }
      toCheck.push({ record, start, key });
    }
    for (const key of [...this.identity.keys()]) if (!seen.has(key)) this.identity.delete(key);
    if (toCheck.length > 0) {
      let times = null;
      try { times = await this.processStartTimes([...new Set(toCheck.map((item) => item.record.pid))]); }
      catch { times = null; }
      for (const { record, start, key } of toCheck) {
        if (!times) { ids.add(record.sessionId); continue; }   // could not check: live
        if (!times.has(record.pid)) continue;                    // gone since the pid check
        const created = times.get(record.pid);
        if (created === null) { ids.add(record.sessionId); continue; }
        const diff = created > start ? created - start : start - created;
        const same = diff <= FILETIME_TOLERANCE;
        this.identity.set(key, { same, at: this.now() });
        if (same) ids.add(record.sessionId);
      }
    }
    return ids;
  }
}

// One-shot form of ClaudeRegistryLiveness.liveIds (no memory across rounds).
export async function liveClaudeSessionIds(options = {}) {
  return new ClaudeRegistryLiveness(options).liveIds({ candidates: options.candidates ?? null });
}

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

export function hasPendingBackgroundWork(sessionId, options) {
  return claudeSessionStatus(sessionId, options) === "shell";
}
