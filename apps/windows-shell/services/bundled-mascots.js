import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultMascotConfig } from "../renderer/default-mascot-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultsDir = path.join(__dirname, "..", "assets", "mascots");

export const bundledPresetSlugs = [
  "chaos-cat",
  "madame-patate",
  "otto",
  "cupidon",
  "masko",
  "rusty",
  "nugget",
  "clippy"
];

function resolveBundledAssetUrl(value) {
  if (typeof value !== "string" || !value.startsWith("./")) return value;
  const resolved = path.resolve(defaultsDir, value);
  if (!resolved.startsWith(`${defaultsDir}${path.sep}`)) throw new Error("bundled_asset_outside_mascots");
  return pathToFileURL(resolved).toString();
}

function resolveBundledAssets(config) {
  for (const node of config.nodes) {
    node.transparentThumbnailUrl = resolveBundledAssetUrl(node.transparentThumbnailUrl);
  }
  for (const edge of config.edges) {
    if (edge.videos) {
      edge.videos.webm = resolveBundledAssetUrl(edge.videos.webm);
      edge.videos.hevc = resolveBundledAssetUrl(edge.videos.hevc);
    }
  }
  return config;
}

function readBundledConfig(slug) {
  const filePath = path.join(defaultsDir, `${slug}.json`);
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw.replace(/,\s*([}\]])/g, "$1"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      return null;
    }
    return resolveBundledAssets(parsed);
  } catch {
    return null;
  }
}

export function loadBundledMascots() {
  const mascots = bundledPresetSlugs.map((slug) => {
    const config = readBundledConfig(slug);
    if (!config) {
      return null;
    }
    return {
      id: `bundled:${slug}`,
      slug,
      source: "bundled",
      addedAt: new Date().toISOString(),
      config
    };
  }).filter(Boolean);

  if (mascots.length === 0) {
    return [
      {
        id: "masko-default",
        slug: "masko",
        source: "bundled",
        addedAt: new Date().toISOString(),
        config: defaultMascotConfig
      }
    ];
  }

  return mascots;
}
