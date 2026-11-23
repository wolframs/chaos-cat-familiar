import fs from "node:fs";
import path from "node:path";

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const blockFor = (ms) => { if (ms > 0) Atomics.wait(sleepCell, 0, 0, ms); };

// Synchronous file calls under `root` block the calling thread for `delayMs`; rename calls 1, 1 + lockEvery, ... there
// fail with EPERM, as when a reader or the scanner holds the target, so with the default every rename is locked once
// and its first retry goes through. Returns a restore function and counters.
export function injectFileDelays({ root, delayMs = 25, lockEvery = 2 }) {
  const prefix = path.resolve(root).toLowerCase();
  const under = (file) => typeof file === "string" && path.resolve(file).toLowerCase().startsWith(prefix);
  const descriptors = new Set();
  const stats = { delayedCalls: 0, delayedMs: 0, renameLocks: 0 };
  const originals = {};
  let renames = 0;
  const delay = () => { stats.delayedCalls++; stats.delayedMs += delayMs; blockFor(delayMs); };
  const wrap = (name, isTarget, after) => {
    originals[name] = fs[name];
    fs[name] = function (...args) {
      const target = isTarget(args);
      if (target) delay();
      const result = originals[name].apply(this, args);
      after?.(target, result, args);
      return result;
    };
  };
  wrap("openSync", ([file]) => under(file), (target, fd) => { if (target) descriptors.add(fd); });
  wrap("closeSync", ([fd]) => false, (_target, _result, [fd]) => descriptors.delete(fd));
  wrap("fsyncSync", ([fd]) => descriptors.has(fd));
  wrap("writeFileSync", ([file]) => under(file) || descriptors.has(file));
  wrap("appendFileSync", ([file]) => under(file));
  wrap("readFileSync", ([file]) => under(file));
  originals.renameSync = fs.renameSync;
  fs.renameSync = function (source, destination) {
    if (under(destination)) {
      delay();
      if (renames++ % lockEvery === 0) {
        stats.renameLocks++;
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${source}' -> '${destination}'`), { code: "EPERM" });
      }
    }
    return originals.renameSync.call(this, source, destination);
  };
  return { stats, restore() { Object.assign(fs, originals); } };
}
