import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_BYTES = 20 * 1024 * 1024;
const FORMATS = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return "image/gif";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}

export function composeImageMessage(text, images = []) {
  if (!images.length) return text;
  const prompt = typeof text === "string" && text.trim() ? text.trim() : "Please look at the attached images.";
  return `${prompt}\n\nAttached images (use these image files as visual context):\n${images.map((image, index) =>
    `${index + 1}. ${image.name}: "${image.path}"`).join("\n")}`;
}

export class CompanionAttachments {
  constructor({ directory }) {
    this.directory = path.resolve(directory);
    this.pending = new Map();
    this.adding = 0;
  }

  list() { return [...this.pending.values()].map((image) => ({ ...image })); }

  async addDataUrl({ name = "Screenshot.png", dataUrl } = {}) {
    if (this.pending.size + this.adding >= 8) throw new Error("Attach up to eight images per message.");
    if (typeof dataUrl !== "string" || dataUrl.length > MAX_BYTES * 1.4) throw new Error("Images must be smaller than 20 MB.");
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    if (!match) throw new Error("Supported images: PNG, JPEG, GIF and WebP.");
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length > MAX_BYTES) throw new Error("Images must be smaller than 20 MB.");
    if (imageType(bytes) !== match[1]) throw new Error("The attachment does not contain a valid image.");
    const id = randomUUID();
    const destination = path.join(this.directory, `${id}.${FORMATS[match[1]]}`);
    this.adding++;
    try {
      await mkdir(this.directory, { recursive: true });
      await writeFile(destination, bytes, { flag: "wx" });
      const image = { id, name: path.win32.basename(String(name)).replace(/[\x00-\x1f]/g, "").slice(0, 150) || "Image",
        path: destination, previewUrl: pathToFileURL(destination).href, size: bytes.length };
      this.pending.set(id, image);
      return { ...image };
    } finally { this.adding--; }
  }

  async addFile(filename) {
    const details = await stat(filename);
    if (!details.isFile() || details.size > MAX_BYTES) throw new Error("Choose an image file smaller than 20 MB.");
    const bytes = await readFile(filename);
    const mime = imageType(bytes);
    if (!mime) throw new Error("Supported images: PNG, JPEG, GIF and WebP.");
    return this.addDataUrl({ name: path.basename(filename), dataUrl: `data:${mime};base64,${bytes.toString("base64")}` });
  }

  select(ids = []) {
    if (!Array.isArray(ids) || ids.length > 8) throw new Error("Invalid image attachment selection.");
    return [...new Set(ids)].map((id) => {
      const image = this.pending.get(id);
      if (!image) throw new Error("That image attachment is no longer available.");
      return { ...image };
    });
  }

  markSent(ids) { for (const id of ids) this.pending.delete(id); }

  async remove(id) {
    const image = this.pending.get(id);
    if (!image) return false;
    await unlink(image.path).catch((error) => { if (error.code !== "ENOENT") throw error; });
    this.pending.delete(id);
    return true;
  }
}
