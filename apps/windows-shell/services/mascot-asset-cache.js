import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

function extensionForUrl(rawUrl) {
  try {
    const pathname = new URL(rawUrl).pathname;
    const ext = path.extname(pathname);
    return /^\.[a-z0-9]{1,8}$/i.test(ext) ? ext : ".bin";
  } catch {
    return ".bin";
  }
}

function stableFileName(rawUrl) {
  const hash = crypto.createHash("sha1").update(rawUrl).digest("hex").slice(0, 12);
  return `${hash}${extensionForUrl(rawUrl)}`;
}

const CACHED_FILE = /^[a-f0-9]{12}\.[a-z0-9]{1,8}$/i;

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

// Downloads of remote mascot assets, kept as files. Main owns it (the library), so no call blocks (step 7).
export class MascotAssetCache {
  constructor({ cacheDir, fetchImpl = globalThis.fetch, logger, maxCacheBytes = 128 * 1024 * 1024, maxAssetBytes = 16 * 1024 * 1024, timeoutMs = 30_000 } = {}) {
    this.cacheDir = cacheDir;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.maxCacheBytes = maxCacheBytes;
    this.maxAssetBytes = maxAssetBytes;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.controllers = new Set();
    this.disposed = false;
    this.cachedBytes = null;
  }

  // What the cache holds (its own files only; diagnostics show it): one directory listing, not a tree walk.
  async stats() {
    if (!this.cacheDir) return { exists: false, bytes: 0, files: 0 };
    let entries;
    try { entries = await fs.readdir(this.cacheDir, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return { exists: false, bytes: 0, files: 0 }; throw error; }
    let bytes = 0;
    let files = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !CACHED_FILE.test(entry.name)) continue;
      try { bytes += (await fs.stat(path.join(this.cacheDir, entry.name))).size; files += 1; } catch { /* removed meanwhile */ }
    }
    return { exists: true, bytes, files };
  }

  dispose() {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  async cacheConfigAssets(config) {
    if (!config || typeof config !== "object") {
      return config;
    }

    const nextConfig = structuredClone(config);

    if (Array.isArray(nextConfig.nodes)) {
      for (const node of nextConfig.nodes) {
        node.transparentThumbnailUrl = await this.cacheUrl(node.transparentThumbnailUrl);
      }
    }

    if (Array.isArray(nextConfig.edges)) {
      for (const edge of nextConfig.edges) {
        if (!edge.videos) {
          continue;
        }
        edge.videos.webm = await this.cacheUrl(edge.videos.webm);
        edge.videos.hevc = await this.cacheUrl(edge.videos.hevc);
      }
    }

    return nextConfig;
  }

  cacheUrl(rawUrl) {
    if (this.pending.has(rawUrl)) return this.pending.get(rawUrl);
    const task = this.queue.then(() => this.#cacheUrl(rawUrl));
    this.queue = task.catch(() => {});
    this.pending.set(rawUrl, task);
    task.finally(() => this.pending.delete(rawUrl));
    return task;
  }

  async #readBytes(response, signal) {
    const declared = Number(response.headers?.get?.("content-length"));
    if (declared > this.maxAssetBytes) throw new Error("mascot_asset_too_large");
    if (!response.body?.getReader) {
      const bytes = Buffer.from(await abortable(response.arrayBuffer(), signal));
      if (bytes.length > this.maxAssetBytes) throw new Error("mascot_asset_too_large");
      return bytes;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    let finished = false;
    try {
      while (true) {
        const { done, value } = await abortable(reader.read(), signal);
        if (done) { finished = true; return Buffer.concat(chunks, size); }
        size += value.byteLength;
        if (size > this.maxAssetBytes) throw new Error("mascot_asset_too_large");
        chunks.push(Buffer.from(value));
      }
    } finally {
      if (!finished) Promise.resolve(reader.cancel()).catch(() => {});
      reader.releaseLock?.();
    }
  }

  async #cacheUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") {
      return rawUrl ?? null;
    }
    if (!/^https?:\/\//i.test(rawUrl)) {
      return rawUrl;
    }
    if (this.disposed || !this.cacheDir || typeof this.fetchImpl !== "function") {
      return rawUrl;
    }

    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      if (this.cachedBytes === null) this.cachedBytes = (await this.stats()).bytes;
      const destination = path.join(this.cacheDir, stableFileName(rawUrl));
      if (!(await exists(destination))) {
        if (this.cachedBytes >= this.maxCacheBytes) return rawUrl;
        const response = await abortable(this.fetchImpl(rawUrl, { signal: controller.signal }), controller.signal);
        if (!response?.ok) {
          return rawUrl;
        }
        const bytes = await this.#readBytes(response, controller.signal);
        if (this.disposed || controller.signal.aborted || this.cachedBytes + bytes.length > this.maxCacheBytes) return rawUrl;
        await fs.writeFile(destination, bytes);
        this.cachedBytes += bytes.length;
      }
      return pathToFileURL(destination).toString();
    } catch (error) {
      controller.abort();
      this.logger?.warn("mascot", "Failed to cache mascot asset", {
        url: rawUrl,
        error: String(error.message ?? error)
      });
      return rawUrl;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("mascot_asset_download_aborted"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
