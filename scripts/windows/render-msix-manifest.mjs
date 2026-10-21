import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const metadataPath = path.join(repoRoot, "packaging", "windows", "package-metadata.json");
const assetMapPath = path.join(repoRoot, "packaging", "windows", "msix-visual-assets.json");
const templatePath = path.join(repoRoot, "packaging", "windows", "AppxManifest.template.xml");
const outputPath = path.join(repoRoot, "packaging", "windows", "AppxManifest.dev.xml");

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildProtocolExtensions(protocols) {
  if (!Array.isArray(protocols) || protocols.length === 0) {
    return "";
  }

  const lines = [
    '      <Extensions>',
    ...protocols.map(
      (protocol) =>
        `        <uap:Extension Category="windows.protocol">\n` +
        `          <uap:Protocol Name="${escapeXml(protocol.name)}">\n` +
        `            <uap:DisplayName>${escapeXml(protocol.displayName)}</uap:DisplayName>\n` +
        `          </uap:Protocol>\n` +
        `        </uap:Extension>`
    ),
    "      </Extensions>",
  ];

  return lines.join("\n");
}

const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
const visualAssets = JSON.parse(fs.readFileSync(assetMapPath, "utf8"));
const template = fs.readFileSync(templatePath, "utf8");

const replacements = {
  identityName: metadata.identityName,
  publisher: metadata.publisher,
  version: `${metadata.version ?? "0.1.0"}.0`,
  displayName: metadata.displayName,
  publisherDisplayName: metadata.publisherDisplayName,
  description: metadata.description,
  storeLogo: visualAssets.assets.storeLogo,
  applicationId: metadata.applicationId ?? metadata.executableBaseName,
  executablePath: metadata.executablePath ?? `${metadata.executableBaseName}.exe`,
  square44x44Logo: visualAssets.assets.square44x44Logo,
  square150x150Logo: visualAssets.assets.square150x150Logo,
  square310x310Logo: visualAssets.assets.square310x310Logo,
  wide310x150Logo: visualAssets.assets.wide310x150Logo,
  protocolExtensionsRaw: buildProtocolExtensions(metadata.protocols),
};

let rendered = template;
for (const [key, value] of Object.entries(replacements)) {
  if (key.endsWith("Raw")) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  } else {
    rendered = rendered.replaceAll(`{{${key}}}`, escapeXml(value));
  }
}

fs.writeFileSync(outputPath, `${rendered}\n`);
console.log(`[ccf-msix] wrote ${path.relative(repoRoot, outputPath)}`);
