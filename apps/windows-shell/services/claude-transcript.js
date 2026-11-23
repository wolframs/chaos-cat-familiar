import fs from "node:fs";
import { MAINTENANCE_PROMPT_PREFIX } from "../../../packages/core/src/models.js";

function textOf(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join(" ").trim();
}

// Whether the transcript's last turn was started by a cache-warm ping: true, false, or null when the tail holds no
// prompt or the file cannot be read. Read at a Claude Stop (review 2, finding 4): the prompt is written to the
// transcript when it is submitted, so at Stop the last prompt there is the one that turn answered, whatever order
// the hooks arrive in. Turn starters: a typed prompt, a slash command, a background task's notification; tool results,
// meta and sidechain entries and hook/command output (other text starting with "<") start none.
export async function lastPromptIsMaintenance(transcriptPath, { fsp = fs.promises, tailBytes = 256 * 1024 } = {}) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;
  let handle;
  let text;
  try {
    handle = await fsp.open(transcriptPath, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, tailBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    text = buffer.toString("utf8");
    if (size > length) text = text.slice(text.indexOf("\n") + 1);   // the first line is cut
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.includes('"user"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== "user" || entry.isSidechain || entry.isMeta || entry.toolUseResult !== undefined) continue;
    const content = entry.message?.content;
    if (Array.isArray(content) && content.some((part) => part?.type === "tool_result")) continue;
    const prompt = textOf(content);
    if (entry.origin?.name === "cache-warm" || prompt.startsWith(MAINTENANCE_PROMPT_PREFIX)) return true;
    if (!prompt) continue;
    if (prompt.startsWith("<") && !prompt.startsWith("<task-notification") && !prompt.startsWith("<command-")) continue;
    return false;
  }
  return null;
}
