import fs from "node:fs/promises";
import path from "node:path";
import { defaultMascotConfig } from "../renderer/default-mascot-config.js";
import { MascotAssetCache } from "./mascot-asset-cache.js";
import { loadBundledMascots } from "./bundled-mascots.js";

async function createDefaultRecord() {
  const bundledMascots = await loadBundledMascots();
  const defaultMascotId = bundledMascots.find((item) => item.slug === "chaos-cat")?.id
    ?? bundledMascots.find((item) => item.slug === "masko")?.id
    ?? bundledMascots[0]?.id
    ?? "masko-default";
  return {
    version: 2,
    currentMascotId: defaultMascotId,
    mascots: bundledMascots.length > 0
      ? bundledMascots
      : [
        {
          id: "masko-default",
          slug: "masko",
          source: "bundled",
          addedAt: new Date().toISOString(),
          config: defaultMascotConfig
        }
      ]
  };
}

function sanitizeSlug(slug) {
  return String(slug ?? "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
}

// The mascots main shows (mascots.json and the bundled presets). Main owns it, so its file work is asynchronous: the
// library loads on first use, and each change is written in order, newest last (process-split plan, step 7).
export class MascotLibrary {
  constructor({ filePath, fetchImpl = globalThis.fetch, cacheDir, logger } = {}) {
    this.filePath = filePath;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.assetCache = new MascotAssetCache({
      cacheDir,
      fetchImpl,
      logger
    });
    this.state = null;
    this.loading = null;
    this.writes = Promise.resolve();
    this.disposed = false;
  }

  load() {
    this.loading ??= this.#loadState().then((state) => { this.state = state; return this; });
    return this.loading;
  }

  // Cache contents for diagnostics.
  cacheStats() { return this.assetCache.stats(); }

  dispose() {
    this.disposed = true;
    this.assetCache.dispose();
  }

  async list() {
    await this.load();
    return {
      currentMascotId: this.state.currentMascotId,
      mascots: this.state.mascots.map((item) => this.#toPublicMascot(item))
    };
  }

  async current() {
    await this.load();
    const mascot = this.state.mascots.find((item) => item.id === this.state.currentMascotId) ?? this.state.mascots[0];
    return mascot ? this.#toPublicMascot(mascot) : null;
  }

  async select(id) {
    await this.load();
    const mascot = this.state.mascots.find((item) => item.id === id);
    if (!mascot) {
      return {
        ok: false,
        error: "unknown_mascot"
      };
    }
    this.state.currentMascotId = mascot.id;
    await this.#persist();
    this.logger?.info("mascot", "Mascot selected", {
      mascotId: mascot.id,
      slug: mascot.slug ?? null
    });
    return {
      ok: true,
      mascot: this.#toPublicMascot(mascot)
    };
  }

  async installFromSlug(slug) {
    const sanitizedSlug = sanitizeSlug(slug);
    if (!sanitizedSlug) {
      return {
        ok: false,
        error: "invalid_slug"
      };
    }

    await this.load();
    const existing = this.state.mascots.find((item) => item.slug === sanitizedSlug);
    if (existing) {
      this.state.currentMascotId = existing.id;
      await this.#persist();
      return {
        ok: true,
        mascot: this.#toPublicMascot(existing),
        action: "selected_existing"
      };
    }

    if (typeof this.fetchImpl !== "function") {
      return {
        ok: false,
        error: "fetch_unavailable"
      };
    }

    const response = await this.fetchImpl(`https://masko.ai/api/mascot-templates/${sanitizedSlug}`);
    if (!response?.ok) {
      return {
        ok: false,
        error: "fetch_failed",
        status: response?.status ?? null
      };
    }

    const config = await response.json();
    const cachedConfig = await this.assetCache.cacheConfigAssets(config);
    if (this.disposed) return { ok: false, error: "disposed" };
    const mascot = {
      id: `slug:${sanitizedSlug}`,
      slug: sanitizedSlug,
      source: "remote",
      addedAt: new Date().toISOString(),
      config: cachedConfig
    };
    this.state.mascots.unshift(mascot);
    this.state.currentMascotId = mascot.id;
    await this.#persist();
    this.logger?.info("mascot", "Mascot installed from slug", {
      slug: sanitizedSlug,
      mascotId: mascot.id
    });
    return {
      ok: true,
      mascot: this.#toPublicMascot(mascot),
      action: "installed"
    };
  }

  async warmBundledAssets() {
    await this.load();
    const bundled = this.state.mascots.find((item) => item.id === this.state.currentMascotId && item.source === "bundled")
      ?? this.state.mascots.find((item) => item.slug === "chaos-cat")
      ?? this.state.mascots.find((item) => item.source === "bundled");
    if (!bundled) {
      return null;
    }
    const cachedConfig = await this.assetCache.cacheConfigAssets(bundled.config);
    if (this.disposed) return null;
    bundled.config = cachedConfig;
    await this.#persist();
    return this.#toPublicMascot(bundled);
  }

  async importConfig(config, options = {}) {
    await this.load();
    if (!config || typeof config !== "object") {
      return {
        ok: false,
        error: "invalid_config"
      };
    }

    const slug = sanitizeSlug(options.slug || config.name || `custom-${Date.now()}`) || `custom-${Date.now()}`;
    const mascot = {
      id: options.id || `custom:${slug}:${Date.now()}`,
      slug,
      source: options.source ?? "custom",
      addedAt: new Date().toISOString(),
      config
    };
    this.state.mascots.unshift(mascot);
    this.state.currentMascotId = mascot.id;
    await this.#persist();
    this.logger?.info("mascot", "Mascot imported from JSON", {
      mascotId: mascot.id,
      slug
    });
    return {
      ok: true,
      action: "imported",
      mascot: this.#toPublicMascot(mascot)
    };
  }

  async updateConfig(id, config) {
    await this.load();
    const mascot = this.state.mascots.find((item) => item.id === id);
    if (!mascot) {
      return {
        ok: false,
        error: "unknown_mascot"
      };
    }
    mascot.config = config;
    await this.#persist();
    this.logger?.info("mascot", "Mascot config updated", {
      mascotId: mascot.id,
      slug: mascot.slug ?? null
    });
    return {
      ok: true,
      action: "updated",
      mascot: this.#toPublicMascot(mascot)
    };
  }

  async remove(id) {
    await this.load();
    const mascot = this.state.mascots.find((item) => item.id === id);
    if (!mascot) {
      return {
        ok: false,
        error: "unknown_mascot"
      };
    }
    if (mascot.source === "bundled") {
      return {
        ok: false,
        error: "bundled_mascot_cannot_be_removed"
      };
    }
    this.state.mascots = this.state.mascots.filter((item) => item.id !== id);
    if (this.state.currentMascotId === id) {
      this.state.currentMascotId = this.state.mascots[0]?.id ?? null;
    }
    await this.#persist();
    this.logger?.info("mascot", "Mascot removed", {
      mascotId: id,
      slug: mascot.slug ?? null
    });
    return {
      ok: true,
      action: "removed",
      mascotId: id
    };
  }

  async #loadState() {
    if (!this.filePath) {
      return createDefaultRecord();
    }
    try {
      const raw = await fs.readFile(this.filePath, "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (raw !== null) {
        const parsed = JSON.parse(raw);
        const normalized = await this.#normalizeState(parsed);
        if (parsed.version !== 2) {
          await this.#writeState(normalized).catch((error) => {
            this.logger?.warn("mascot", "Failed to persist mascot library migration", {
              error: String(error.message ?? error)
            });
          });
        }
        return normalized;
      }
    } catch (error) {
      this.logger?.warn("mascot", "Failed to load mascot library, reseeding default mascot", {
        error: String(error.message ?? error)
      });
    }
    const seeded = await createDefaultRecord();
    await this.#writeState(seeded).catch((error) => {
      this.logger?.warn("mascot", "Failed to save the seeded mascot library", { error: String(error.message ?? error) });
    });
    return seeded;
  }

  async #normalizeState(parsed) {
    const base = await createDefaultRecord();
    const mascots = Array.isArray(parsed?.mascots) && parsed.mascots.length > 0
      ? parsed.mascots.filter((item) => item?.id && item?.config)
      : base.mascots;
    const knownIds = new Set(mascots.map((item) => item.id));
    for (const bundled of base.mascots) {
      if (!knownIds.has(bundled.id)) {
        mascots.push(bundled);
      } else if (bundled.id === "bundled:chaos-cat") {
        const index = mascots.findIndex((item) => item.id === bundled.id);
        mascots[index] = { ...bundled, addedAt: mascots[index].addedAt ?? bundled.addedAt };
      }
    }
    const selectedId = parsed?.version !== 2 && parsed?.currentMascotId === "bundled:masko" && mascots.some((item) => item.id === "bundled:chaos-cat")
      ? "bundled:chaos-cat"
      : parsed?.currentMascotId;
    const currentMascotId = mascots.some((item) => item.id === selectedId)
      ? selectedId
      : mascots[0].id;
    return {
      version: 2,
      currentMascotId,
      mascots
    };
  }

  // Resolves once this change is on disk; a failed write is logged, the library keeps the change in memory.
  #persist() {
    return this.#writeState(this.state).catch((error) => {
      this.logger?.warn("mascot", "Failed to save the mascot library", { error: String(error.message ?? error) });
    });
  }

  // Writes one after another; each takes the content of its moment, so the newest change lands last.
  #writeState(value) {
    if (!this.filePath) {
      return Promise.resolve();
    }
    const text = JSON.stringify(value, null, 2);
    const write = this.writes.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, text);
    });
    this.writes = write.catch(() => {});
    return write;
  }

  #toPublicMascot(mascot) {
    return {
      id: mascot.id,
      slug: mascot.slug ?? null,
      source: mascot.source ?? "bundled",
      addedAt: mascot.addedAt,
      name: mascot.config?.name ?? "Mascot",
      config: mascot.config
    };
  }
}
