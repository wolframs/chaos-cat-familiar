import fs from "node:fs";
import path from "node:path";

// The side panel and the cluster menu under real Electron (docs/ARCHITECTURE.md, "The side panel and the cluster
// menu"), part of windows-shell-smoke.mjs. Generic fixture data only: the smoke runs against a temp home.
export function sidePanelFixturePath(home) {
  return path.join(home, "repos", "work-companion", "state", "panel.json");
}

export function writeSidePanelFixture(file, { text = "#123 Example ticket", ageMs = 0, raw = null } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const generatedAt = new Date(Date.now() - ageMs);
  const offset = -generatedAt.getTimezoneOffset();
  const pad = (value) => String(Math.floor(Math.abs(value))).padStart(2, "0");
  const local = new Date(generatedAt.getTime() + offset * 60000).toISOString().slice(0, 19)
    + `${offset >= 0 ? "+" : "-"}${pad(offset / 60)}:${pad(offset % 60)}`;
  const content = raw ?? JSON.stringify({
    schema: "ccf-side-panel/1", generatedAt: local, staleAfterSec: 420, title: "companion",
    sections: [
      { id: "on-you", title: "On you", count: 2, more: { label: "pinned.md", url: "file:///C:/example/pinned.md" }, items: [
        { id: "w1", text: "session-a · dialog open", glyph: "⏸", tone: "attention", since: local, session: "session-a-0001",
          detail: "Waiting on a permission dialog." },
        { id: "p1", text: text, detail: "Review round 1 done; five threads to fix in the two pull requests.",
          link: "https://example.invalid/items/123", links: [{ label: "PR 11", url: "https://example.invalid/pr/11" },
            { label: "PR 12", url: "https://example.invalid/pr/12" }], copy: "#123" }
      ] },
      { id: "active", title: "Active", items: [
        { id: "s1", text: "session-a · #123", glyph: "●", tone: "busy", meta: "busy", since: local, session: "session-a-0001" },
        { id: "s2", text: "session-b", glyph: "○", tone: "idle", meta: "idle", since: local, session: "session-b-0002" }
      ] },
      { id: "tickets", title: "Tickets", count: 9, summary: "3 of 9", stale: true, note: "tracker: last ok 47m ago",
        more: { label: "assigned to me", url: "https://example.invalid/assigned" }, items: [
          { id: "t1", text: "#123 Example ticket with a long title that does not fit", glyph: "●", tone: "busy", meta: "Doing",
            link: "https://example.invalid/items/123", copy: "#123" },
          { id: "t2", text: "#124 Another example", glyph: "↻", tone: "attention", meta: "Test", link: "https://example.invalid/items/124", copy: "#124" },
          { id: "t3", text: "#125 Third example", glyph: "·", tone: "muted", meta: "New", copy: "#125" }
        ] },
      { id: "loops", title: "Loops on you", count: 4, summary: "40 open · 9 free", collapsed: true,
        more: { label: "OPEN-LOOPS.md", url: "file:///C:/example/OPEN-LOOPS.md" },
        items: [{ id: "L-1", text: "L-1 Example loop", glyph: "○", meta: "11-17", copy: "L-1" }] }
    ]
  });
  fs.writeFileSync(file, content);
  if (raw) {
    // An old mtime: not a writer caught mid-replace, so it turns invalid at once.
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(file, old, old);
  }
}

export async function runSidePanelSmoke({ controlPort, controlHeaders, home, captureDir = null, delay }) {
  const base = `http://127.0.0.1:${controlPort}`;
  const readDiagnostics = async () => (await fetch(`${base}/diagnostics-summary`, { headers: controlHeaders })).json();
  const waitFor = async (read, what, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await read();
      if (value) return value;
      await delay(100);
    }
    throw new Error(`Side panel smoke: timed out waiting for ${what}`);
  };
  const menuClick = async (surface, id) => {
    const response = await fetch(`${base}/menu-click`, { method: "POST", headers: controlHeaders, body: JSON.stringify({ surface, id }) });
    if (!response.ok) throw new Error(`Menu click ${surface}/${id} failed: ${await response.text()}`);
  };
  const capture = async (name) => {
    if (!captureDir) return;
    await delay(400);
    const image = await fetch(`${base}/capture-companion-panel`, { headers: controlHeaders });
    if (!image.ok) throw new Error(`Side panel capture ${name} failed: ${image.status}`);
    fs.writeFileSync(path.join(captureDir, `${name}.png`), Buffer.from(await image.arrayBuffer()));
  };
  const clusterWindow = (diagnostics, kind) => diagnostics.cluster?.find((item) => item.kind === kind);
  const file = sidePanelFixturePath(home);

  const shown = await fetch(`${base}/companion-preview`, { method: "POST", headers: controlHeaders, body: "null" });
  if (!shown.ok) throw new Error("The companion cluster could not be shown for the side panel");
  let last = null;
  const placed = await waitFor(async () => {
    const diagnostics = last = await readDiagnostics();
    return clusterWindow(diagnostics, "panel")?.visible && diagnostics.sidePanel?.status === "ok" && diagnostics;
  }, "the side panel window with the fixture").catch((error) => {
    throw new Error(`${error.message}: ${JSON.stringify({ cluster: last?.cluster, sidePanel: last?.sidePanel, displays: last?.displays })}`);
  });
  const panel = clusterWindow(placed, "panel").bounds;
  const conversation = clusterWindow(placed, "conversation").bounds;
  // At a fractional display scale bounds read back a pixel off.
  if (Math.abs(panel.x + panel.width - conversation.x) > 2 || Math.abs(panel.y - conversation.y) > 2
    || Math.abs(panel.height - conversation.height) > 2) {
    throw new Error(`The side panel is not left of the conversation: ${JSON.stringify({ panel, conversation })}`);
  }
  if (placed.sidePanel.sections?.[0]?.items?.[1] !== "#123 Example ticket") {
    throw new Error(`The side panel shows the wrong content: ${JSON.stringify(placed.sidePanel)}`);
  }
  console.log(`Side panel left of the conversation at ${JSON.stringify(panel)}, fixture read`);
  await capture("panel");

  const changedAt = Date.now();
  writeSidePanelFixture(file, { text: "#124 Changed example" });
  await waitFor(async () => (await readDiagnostics()).sidePanel?.sections?.[0]?.items?.[1] === "#124 Changed example",
    "the rewritten fixture", 3000);
  console.log(`Side panel picked up a rewritten file in ${Date.now() - changedAt} ms`);

  writeSidePanelFixture(file, { ageMs: 3600_000 });
  await waitFor(async () => (await readDiagnostics()).sidePanel?.sections?.[0]?.items?.[1] === "#123 Example ticket",
    "the stale fixture", 3000);
  await capture("panel-stale");
  writeSidePanelFixture(file, { raw: "{ \"schema\": \"ccf-side-panel/1\", broken" });
  await waitFor(async () => (await readDiagnostics()).sidePanel?.status === "invalid", "the invalid file", 3000);
  await capture("panel-invalid");
  fs.rmSync(file);
  await waitFor(async () => (await readDiagnostics()).sidePanel?.status === "missing", "the missing file", 3000);
  writeSidePanelFixture(file);
  await waitFor(async () => (await readDiagnostics()).sidePanel?.status === "ok", "the restored fixture", 3000);
  console.log("Side panel: stale, invalid and missing states seen");

  const clusterOf = (diagnostics) => ["cat", "conversation", "status", "panel"]
    .map((kind) => clusterWindow(diagnostics, kind)).filter(Boolean);
  await menuClick("tray", "always-on-top");
  let cluster = clusterOf(await readDiagnostics());
  if (cluster.length < 4 || cluster.some((item) => item.alwaysOnTop !== false)) {
    throw new Error(`Always on Top off left a window on top: ${JSON.stringify(cluster)}`);
  }
  await delay(3000);
  cluster = clusterOf(await readDiagnostics());
  if (cluster.some((item) => item.alwaysOnTop !== false)) {
    throw new Error(`Something put the cluster back on top within 3 s: ${JSON.stringify(cluster)}`);
  }
  await menuClick("cat", "always-on-top");
  cluster = clusterOf(await readDiagnostics());
  if (cluster.some((item) => item.alwaysOnTop !== true)) throw new Error(`Always on Top on did not return: ${JSON.stringify(cluster)}`);
  console.log("Always on Top: off held for 3 s on every cluster window, on restored it");

  await menuClick("cat", "minimize-to-tray");
  cluster = clusterOf(await readDiagnostics());
  if (cluster.some((item) => item.visible)) throw new Error(`Minimize to Tray left windows visible: ${JSON.stringify(cluster)}`);
  if ((await readDiagnostics()).sidePanel?.status !== "ok") throw new Error("The side panel lost its content while hidden");
  await menuClick("tray", "show-companion");
  cluster = await waitFor(async () => {
    const windows = clusterOf(await readDiagnostics());
    return windows.length === 4 && windows.every((item) => item.visible) && windows;
  }, "the cluster restored by Show Companion");
  console.log("Minimize to Tray hid the cluster with its panel; Show Companion restored it");
}
