import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MascotAssetCache } from "../services/mascot-asset-cache.js";

function fixture(t, options = {}) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-cache-bounds-"));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const cache = new MascotAssetCache({ cacheDir, ...options });
  t.after(() => cache.dispose());
  return { cache, cacheDir };
}

test("cache bounds total bytes, preserves unrelated files and reuses existing downloads", async (t) => {
  let calls = 0;
  const { cache, cacheDir } = fixture(t, { maxCacheBytes: 6, maxAssetBytes: 4, fetchImpl: async () => { calls += 1; return { ok: true, arrayBuffer: async () => Buffer.from("four") }; } });
  fs.writeFileSync(path.join(cacheDir, "user-notes.txt"), "must stay");
  const first = await cache.cacheUrl("https://example.com/a.png");
  assert.match(first, /^file:/);
  assert.equal(await cache.cacheUrl("https://example.com/a.png"), first);
  assert.equal(await cache.cacheUrl("https://example.com/b.png"), "https://example.com/b.png");
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(path.join(cacheDir, "user-notes.txt"), "utf8"), "must stay");
  assert.equal(fs.readdirSync(cacheDir).length, 2);
});

test("stream overflow cancels its reader and never writes a partial asset", async (t) => {
  let cancelled = false;
  const { cache, cacheDir } = fixture(t, { maxAssetBytes: 3, fetchImpl: async () => ({ ok: true, body: { getReader() { return { read: async () => ({ done: false, value: Buffer.from("large") }), cancel() { cancelled = true; return Promise.resolve(); }, releaseLock() {} }; } } }) });
  assert.equal(await cache.cacheUrl("https://example.com/a.png"), "https://example.com/a.png");
  assert.equal(cancelled, true);
  assert.deepEqual(fs.readdirSync(cacheDir), []);
});

test("dispose aborts in-flight work, settles queued work and prevents later fetches", { timeout: 2000 }, async (t) => {
  let signal;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const { cache } = fixture(t, { fetchImpl: async (_url, options) => { signal = options.signal; started(); return new Promise(() => {}); } });
  const pending = cache.cacheUrl("https://example.com/a.png");
  const queued = cache.cacheUrl("https://example.com/b.png");
  await ready;
  cache.dispose();
  assert.equal(signal.aborted, true);
  assert.equal(await pending, "https://example.com/a.png");
  assert.equal(await queued, "https://example.com/b.png");
  assert.equal(await cache.cacheUrl("https://example.com/c.png"), "https://example.com/c.png");
});

test("a stalled download times out and concurrent duplicate requests share one fetch", { timeout: 2000 }, async (t) => {
  let calls = 0;
  const { cache } = fixture(t, { timeoutMs: 10, fetchImpl: async () => { calls += 1; return new Promise(() => {}); } });
  const values = await Promise.all([cache.cacheUrl("https://example.com/a.png"), cache.cacheUrl("https://example.com/a.png")]);
  assert.equal(calls, 1);
  assert.deepEqual(values, ["https://example.com/a.png", "https://example.com/a.png"]);
});
