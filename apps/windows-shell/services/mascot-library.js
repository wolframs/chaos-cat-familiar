import fs from "node:fs";
import path from "node:path";
import { defaultMascotConfig } from "../renderer/default-mascot-config.js";
import { MascotAssetCache } from "./mascot-asset-cache.js";
import { loadBundledMascots } from "./bundled-mascots.js";

function createDefaultRecord() {
  const bundledMascots = loadBundledMascots();
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
    this.state = this.#loadState();
    this.disposed = false;
  }

  dispose() {
    this.disposed = true;
    this.assetCache.dispose();
  }

  list() {
    return {
      currentMascotId: this.state.currentMascotId,
      mascots: this.state.mascots.map((item) => this.#toPublicMascot(item))
    };
  }

  current() {
    const mascot = this.state.mascots.find((item) => item.id === this.state.currentMascotId) ?? this.state.mascots[0];
    return mascot ? this.#toPublicMascot(mascot) : null;
  }

  select(id) {
    const mascot = this.state.mascots.find((item) => item.id === id);
    if (!mascot) {
      return {
        ok: false,
        error: "unknown_mascot"
      };
    }
    this.state.currentMascotId = mascot.id;
    this.#persist();
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

    const existing = this.state.mascots.find((item) => item.slug === sanitizedSlug);
    if (existing) {
      this.state.currentMascotId = existing.id;
      this.#persist();
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
    this.#persist();
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
    const bundled = this.state.mascots.find((item) => item.id === this.state.currentMascotId && item.source === "bundled")
      ?? this.state.mascots.find((item) => item.slug === "chaos-cat")
      ?? this.state.mascots.find((item) => item.source === "bundled");
    if (!bundled) {
      return null;
    }
    const cachedConfig = await this.assetCache.cacheConfigAssets(bundled.config);
    if (this.disposed) return null;
    bundled.config = cachedConfig;
    this.#persist();
    return this.#toPublicMascot(bundled);
  }

  importConfig(config, options = {}) {
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
    this.#persist();
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

  updateConfig(id, config) {
    const mascot = this.state.mascots.find((item) => item.id === id);
    if (!mascot) {
      return {
        ok: false,
        error: "unknown_mascot"
      };
    }
    mascot.config = config;
    this.#persist();
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

  remove(id) {
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
    this.#persist();
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

  #loadState() {
    if (!this.filePath) {
      return createDefaultRecord();
    }
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
        const normalized = this.#normalizeState(parsed);
        if (parsed.version !== 2) {
          try {
            this.#writeState(normalized);
          } catch (error) {
            this.logger?.warn("mascot", "Failed to persist mascot library migration", {
              error: String(error.message ?? error)
            });
          }
        }
        return normalized;
      }
    } catch (error) {
      this.logger?.warn("mascot", "Failed to load mascot library, reseeding default mascot", {
        error: String(error.message ?? error)
      });
    }
    const seeded = createDefaultRecord();
    this.#writeState(seeded);
    return seeded;
  }

  #normalizeState(parsed) {
    const base = createDefaultRecord();
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

  #persist() {
    this.#writeState(this.state);
  }

  #writeState(value) {
    if (!this.filePath) {
      return;
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(value, null, 2));
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
