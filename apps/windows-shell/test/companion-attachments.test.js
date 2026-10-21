import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CompanionAttachments, composeImageMessage } from "../services/companion-attachments.js";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VVcAAAAASUVORK5CYII=";
const roots = [];
after(async () => { for (const root of roots) await fs.rm(root, { recursive: true, force: true }); });
async function store() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ccf-images-test-"));
  roots.push(directory);
  return new CompanionAttachments({ directory });
}

test("pasted images receive stable app-owned paths and pending images can be removed", async () => {
  const images = await store();
  const attachment = await images.addDataUrl({ name: "Screenshot.png", dataUrl: png });
  assert.equal(images.list().length, 1);
  assert.equal(attachment.name, "Screenshot.png");
  assert.equal(new URL(attachment.previewUrl).protocol, "file:");
  assert.equal((await fs.readFile(attachment.path)).subarray(1, 4).toString(), "PNG");
  await images.remove(attachment.id);
  assert.equal(images.list().length, 0);
  await assert.rejects(fs.stat(attachment.path), { code: "ENOENT" });
});

test("sent images retain their files and failed/unknown selections cannot attach arbitrary paths", async () => {
  const images = await store();
  const attachment = await images.addDataUrl({ name: "Photo.png", dataUrl: png });
  const selected = images.select([attachment.id]);
  assert.ok(composeImageMessage("What is in this picture?", selected).includes(attachment.path));
  assert.ok(composeImageMessage("", selected).includes("attached image"));
  assert.throws(() => images.select(["C:\\arbitrary\\private.png"]), /attachment/i);
  assert.equal(images.list().length, 1, "validation failure leaves pending images in place");
  images.markSent([attachment.id]);
  assert.equal(images.list().length, 0);
  assert.ok((await fs.stat(attachment.path)).size > 0, "session image references stay usable");
  assert.equal(await images.remove(attachment.id), false, "pending removal never deletes sent context");
});

test("image staging validates types and bounds the pending queue", async () => {
  const images = await store();
  await assert.rejects(images.addDataUrl({ name: "script.svg", dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" }), /PNG|JPEG|supported/i);
  await assert.rejects(images.addDataUrl({ name: "not.png", dataUrl: "data:image/png;base64,bm90IGFuIGltYWdl" }), /image|invalid/i);
  for (let i = 0; i < 8; i++) await images.addDataUrl({ name: `${i}.png`, dataUrl: png });
  await assert.rejects(images.addDataUrl({ name: "extra.png", dataUrl: png }), /eight|8/i);
  assert.equal(images.list().length, 8);
});
