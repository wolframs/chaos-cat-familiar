import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MascotLibrary } from "../services/mascot-library.js";

const tempRoots = [];
after(() => { for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true }); });

function createTempFilePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccf-mascots-"));
  tempRoots.push(dir);
  return path.join(dir, "mascots.json");
}

test("mascot library seeds the bundled default mascot", () => {
  const library = new MascotLibrary({
    filePath: createTempFilePath(),
    cacheDir: path.join(os.tmpdir(), "ccf-mascots-cache-seed"),
    fetchImpl: async () => {
      throw new Error("should not fetch");
    }
  });

  const state = library.list();
  assert.equal(state.mascots.length >= 1, true);
  assert.equal(state.currentMascotId, "bundled:chaos-cat");
  const familiar = state.mascots.find((item) => item.id === "bundled:chaos-cat");
  assert.equal(familiar.name, "Chaos Cat Familiar");
  assert.equal(familiar.config.animateWhenVisible, true);
  assert.equal(familiar.config.nodes.length, 4);
  assert.equal(familiar.config.edges.length, 16);
  assert.equal(fileURLToPath(familiar.config.nodes[0].transparentThumbnailUrl).endsWith(path.join("mascots", "chaos-cat", "thumbnails", "idle.png")), true);
  assert.equal(fileURLToPath(familiar.config.edges[0].videos.webm).endsWith(path.join("mascots", "chaos-cat", "loops", "idle.webm")), true);
  for (const node of familiar.config.nodes) {
    assert.equal(fs.existsSync(fileURLToPath(node.transparentThumbnailUrl)), true, `missing ${node.name} thumbnail`);
  }
  for (const edge of familiar.config.edges) {
    assert.equal(fs.existsSync(fileURLToPath(edge.videos.webm)), true, `missing ${edge.source} → ${edge.target} clip`);
  }
  assert.equal(familiar.config.nodes.every((node) => node.transparentThumbnailUrl.startsWith("file://")), true);
  assert.equal(familiar.config.edges.every((edge) => edge.videos.webm.startsWith("file://")), true);
  assert.equal(state.mascots.some((item) => item.slug === "masko"), true);
  assert.equal(state.mascots.find((item) => item.slug === "masko").name, "Masko");
});

test("mascot library migrates only the previous bundled default and refreshes bundled familiar assets", () => {
  const filePath = createTempFilePath();
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    currentMascotId: "bundled:masko",
    mascots: [
      { id: "bundled:masko", slug: "masko", source: "bundled", config: { name: "Masko" } },
      { id: "bundled:chaos-cat", slug: "chaos-cat", source: "bundled", config: { name: "Old concept" } }
    ]
  }));
  const library = new MascotLibrary({ filePath, fetchImpl: async () => { throw new Error("should not fetch"); } });
  const state = library.list();
  assert.equal(state.currentMascotId, "bundled:chaos-cat");
  const familiar = state.mascots.find((item) => item.id === "bundled:chaos-cat");
  assert.equal(familiar.name, "Chaos Cat Familiar");
  assert.equal(fileURLToPath(familiar.config.edges[0].videos.webm).endsWith(path.join("mascots", "chaos-cat", "loops", "idle.webm")), true);
  assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).version, 2);
  assert.equal(library.select("bundled:masko").ok, true);
  assert.equal(new MascotLibrary({ filePath }).list().currentMascotId, "bundled:masko");
});

test("mascot library preserves an explicitly selected alternative", () => {
  const filePath = createTempFilePath();
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    currentMascotId: "custom:buddy",
    mascots: [{ id: "custom:buddy", slug: "buddy", source: "custom", config: { name: "Buddy" } }]
  }));
  const library = new MascotLibrary({ filePath, fetchImpl: async () => { throw new Error("should not fetch"); } });
  assert.equal(library.list().currentMascotId, "custom:buddy");
  assert.equal(library.list().mascots.some((item) => item.id === "bundled:chaos-cat"), true);
});

test("mascot library installs a remote mascot by slug and selects it", async () => {
  const library = new MascotLibrary({
    filePath: createTempFilePath(),
    cacheDir: path.join(os.tmpdir(), "ccf-mascots-cache-install"),
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/mascot-templates/remote-rusty")) {
        return {
          ok: true,
          async json() {
            return {
              version: "2.0",
              name: "Rusty",
              initialNode: "idle",
              autoPlay: true,
              nodes: [{ id: "idle", name: "Idle", transparentThumbnailUrl: "https://example.com/rusty.png" }],
              edges: [{ id: "loop", source: "idle", target: "idle", isLoop: true, duration: 4, conditions: [], videos: { webm: "https://example.com/rusty.webm" } }]
            };
          }
        };
      }
      return {
        ok: true,
        async arrayBuffer() {
          return Buffer.from("asset-bytes");
        }
      };
    }
  });

  const result = await library.installFromSlug("remote-rusty");
  assert.equal(result.ok, true);
  assert.equal(result.action, "installed");
  assert.equal(result.mascot.slug, "remote-rusty");
  assert.equal(library.current().id, "slug:remote-rusty");
  assert.equal(result.mascot.config.nodes[0].transparentThumbnailUrl.startsWith("file://"), true);
  assert.equal(result.mascot.config.edges[0].videos.webm.startsWith("file://"), true);
  assert.equal(fs.existsSync(fileURLToPath(result.mascot.config.edges[0].videos.webm)), true);
});

test("mascot library reselects an existing mascot instead of duplicating it", async () => {
  const library = new MascotLibrary({
    filePath: createTempFilePath(),
    cacheDir: path.join(os.tmpdir(), "ccf-mascots-cache-existing"),
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          version: "2.0",
          name: "Rusty",
          initialNode: "idle",
          autoPlay: true,
          nodes: [{ id: "idle", name: "Idle", transparentThumbnailUrl: null }],
          edges: [{ id: "loop", source: "idle", target: "idle", isLoop: true, duration: 4, conditions: [], videos: { webm: "https://example.com/rusty.webm" } }]
        };
      },
      async arrayBuffer() {
        return Buffer.from("asset-bytes");
      }
    })
  });

  await library.installFromSlug("rusty");
  const second = await library.installFromSlug("rusty");

  assert.equal(second.ok, true);
  assert.equal(second.action, "selected_existing");
  assert.equal(library.list().mascots.filter((item) => item.slug === "rusty").length, 1);
});

test("mascot library can warm bundled mascot assets into the local cache", async () => {
  const library = new MascotLibrary({
    filePath: createTempFilePath(),
    cacheDir: path.join(os.tmpdir(), "ccf-mascots-cache-bundled"),
    fetchImpl: async () => ({
      ok: true,
      async arrayBuffer() {
        return Buffer.from("bundled-asset");
      }
    })
  });

  const warmed = await library.warmBundledAssets();
  assert.equal(warmed.slug, "chaos-cat");
  assert.equal(warmed.config.nodes[0].transparentThumbnailUrl.startsWith("file://"), true);
  assert.equal(warmed.config.edges[0].videos.webm.startsWith("file://"), true);
});

test("mascot library imports, updates, and removes custom mascots", () => {
  const library = new MascotLibrary({
    filePath: createTempFilePath(),
    cacheDir: path.join(os.tmpdir(), "ccf-mascots-cache-custom"),
    fetchImpl: async () => {
      throw new Error("should not fetch");
    }
  });

  const imported = library.importConfig({
    version: "2.0",
    name: "Desk Buddy",
    initialNode: "idle",
    autoPlay: true,
    nodes: [{ id: "idle", name: "Idle", transparentThumbnailUrl: null }],
    edges: [{ id: "loop", source: "idle", target: "idle", isLoop: true, duration: 4, conditions: [], videos: { webm: "https://example.com/buddy.webm" } }]
  });
  assert.equal(imported.ok, true);
  assert.equal(imported.action, "imported");

  const updated = library.updateConfig(imported.mascot.id, {
    ...imported.mascot.config,
    name: "Desk Buddy 2"
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.mascot.name, "Desk Buddy 2");

  const removed = library.remove(imported.mascot.id);
  assert.equal(removed.ok, true);
  assert.equal(library.list().mascots.some((item) => item.id === imported.mascot.id), false);
});
