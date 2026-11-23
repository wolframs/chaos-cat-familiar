# Finding your way around CCF

Read [README](../README.md) for running the app, [STATUS](STATUS.md) for current work and limitations,
and [AGENTS](../AGENTS.md) for commands and conventions. The core has no Electron dependency;
the shell injects its platform services.

## Companion backends

All of this runs in the companion's own Electron utility process ("Chaos Cat Familiar Companion"), composed in
[`companion/companion-composition.js`](../apps/windows-shell/companion/companion-composition.js) and started by
[`companion/companion-host.js`](../apps/windows-shell/companion/companion-host.js) the first time the companion is
shown or used (tray, launcher, the conversation window, an action), never with CCF and never starting Claude or Codex
by itself. Main talks to it only through `CompanionClient` ([`companion-service.js`](../apps/windows-shell/services/companion-service.js)):
requests, and pushed snapshots that also carry the staged attachments, the connected Claude folder and the attachment
ids pending or uncertain submissions pin. Main's snapshot is slim (no terminal screen, scrollback or streaming text)
and pushed only when it changed: the whole snapshot is a replaceable frame (`FrameStream`) that the conversation window
takes on its own port (see "State publication" below). A crash leaves the core and its approval sockets alone; the
conversation shows the last snapshot offline (main sends it: the port died with the process), requests are refused
(nothing is queued or resent), and only Start or the launcher's `/companion/open` starts the process again. Before it starts any child the process joins a kill-on-close
job object ([`companion/process-tree.js`](../apps/windows-shell/companion/process-tree.js),
`kill-on-close-job.ps1`), so Claude and everything Claude started, codex app-server, the habitat bridge and the
watcher end with it, crash included.

`CompanionBackends` selects Claude or Codex, guarding active work during switches.
Claude retains `companion-session.js` and its PTY view. Codex uses
`codex-json-rpc.js`, `codex-companion-session.js` and a hidden stdio child process
from `codex-process-transport.js`, inheriting normal user configuration and environment.
There is no native supervisor or production resource ceiling.

`companion-structured.js` renders messages, grouped system updates and approval forms.
The runtime clears matching draft/attachment revisions after backend acceptance.
`CompanionDeliveryStore` keeps conversation identity, outcomes and optional watcher
receipts as rows in the core's SQLite database (see "Persistence" below): the companion asks main, main asks the
core. A transition counts once its commit is acknowledged; a Codex send is transmitted only after its pending record
was. If a commit fails the store blocks visibly (uncertain sends and their images stay) until Start reloads it.
`CompanionWatcher` owns the opt-in source; `CompanionHabitat` coordinates the Python
daily owner and accepted memory. `companion-production.js` supplies source/data paths.

Ordinary Codex hooks use a separate authenticated observation route, backend-qualified
identities and an `integration_source` marker distinct from native `source` metadata.
They have no approval authority. Tests use fake transports and temporary data.
See [contract](CODEX-COMPANION-CONTRACT-v1.md) and [operations](CODEX-COMPANION-OPERATIONS.md).

## A hook's path to the screen

1. Normal startup calls `bootstrapClaudeHooks()` in
   [`windows-shell-runtime.js`](../apps/windows-shell/runtime/windows-shell-runtime.js).
   [`ElectronHookInstallationService`](../apps/windows-shell/services/platform-services.js) writes
   Claude settings atomically. Two transports, one `{matcher: "", hooks: [...]}` entry per event:
   - `SessionStart`, `UserPromptSubmit` (async) and `PermissionRequest` (synchronous, 130-second
     hook timeout, 120-second HTTP timeout) run the generated PowerShell sender, which also adds
     the session's `shell_pid`. SessionStart accepts only command hooks.
   - All other events are Claude Code http hooks that POST the event JSON to
     `http://127.0.0.1:<port>/hook` with the `X-Ccf-Token` header (timeout 5 s). No process starts.
     Before this split, an ETW capture on 2026-11-02 counted 712 sender starts in 30 minutes, each
     behind two Git Bash processes and burning ~0.7 CPU-s.
     With `hookRelayPort` set, these hooks target [`ccf-hook-relay`](../apps/hook-relay/main.go) on that port
     instead: it answers `200 {}` at once, forwards to `/hook` here in arrival order with the token as received,
     and drops events while CCF is not listening, so a closed CCF shows no hook errors in Claude Code.

   Worktree lifecycle hooks are not installed. A port or token change is drift, and the next
   start or repair rewrites both forms.
2. Hooks arrive at [`HookServer`](../packages/core/src/hook-server.js). The server checks the
   loopback Host, rejects browser Origins, and requires `X-Ccf-Token` except on `/health`.
   The per-install token lives in CCF settings, the generated sender and the http hook entries.
   It then checks the payload with [`hook-validator.js`](../packages/core/src/hook-validator.js), then
   [`normalizeEvent()`](../packages/core/src/models.js) converts snake_case fields to camelCase.
   Claude Code waits for an http hook's reply, so every event except `PermissionRequest` gets
   `200 {"ok":true}` right after validation and is ingested afterwards on a serial promise chain
   that keeps arrival order. Ingest failures are logged. `stop()` drains that chain before the
   final commit.
3. [`CcfCoreController`](../packages/core/src/core-controller.js) records sessions, derives
   notifications and manages approvals through its stores. A permission request keeps its HTTP
   connection open until answered or dismissed. Duplicate requests share an approval but have
   separate waiter IDs. A cache-warm ping (`UserPromptSubmit` whose prompt starts with `[Cache warm maintenance]`;
   `normalizeEvent` keeps only the flag `maintenance`) marks its session until the next real prompt, and the
   `Stop` and `idle_prompt` of that turn make no notification. Because that prompt hook comes from the async
   PowerShell sender and may arrive after the turn's `Stop`, a Claude `Stop` is judged by the transcript's last prompt
   (`services/claude-transcript.js`, the controller's `maintenanceTurn`, at most 1.5 s; unreadable: the flag decides).
   The shell's `notificationFilter` has the last word on
   a notification (it renames the hosted companion's idle alert to "Companion idle without its watcher"). Sessions
   end on `SessionEnd`, or, for Claude sessions, when the core's sweep (at start, then every 60 s:
   `ClaudeRegistryLiveness` in `services/claude-session-status.js`, asynchronous, the `.claude/sessions` registry under
   the home the hooks are installed in) no longer lists them live and they were quiet for 2 min
   (`endReason: "vanished"`); a session with a pending approval, Codex sessions and sessions whose transcript is not
   under that home's `.claude` (WSL, another config dir) are never swept. Live means: the file's pid runs and, for
   the sweep's candidates, started at the file's `procStart` (one PowerShell call per check, a match trusted 15 min).
   Uncertain reads count as live: an unreadable file keeps its last good read; a broken file of a running pid never
   read since start stops that round's ends (unless written before that process started).
4. The controller emits `change(snapshot, lastEvent)`. Steps 2 and 3 run in the core process: an Electron
   utility process started by main ([`core/core-process.js`](../apps/windows-shell/core/core-process.js), composed in
   [`core-composition.js`](../apps/windows-shell/core/core-composition.js)) that owns the HookServer with its approval
   waiters, the controller, `settings.json` (the only writer; outside edits are seen within a second and pushed),
   the log file, the state database and the Claude/Codex hook files; its file work happens in its storage worker
   (see "Persistence" below). Main reaches it only through
   [`CoreClient`](../packages/core/src/core-client.js) over [`service-rpc.js`](../packages/core/src/service-rpc.js):
   main's state arrives as versioned deltas that a `StateMirror` applies (see "State publication" below); toasts and
   "show the overlay" are acknowledged effects that main applies after the revision they belong to; `/companion/*`
   comes back as acknowledged intents; settings are a mirror with patches
   ([`settings-authority.js`](../packages/core/src/settings-authority.js)). [`core-host.js`](../apps/windows-shell/core/core-host.js)
   boots the core, installs or repairs hooks only after it reported its port (probed with the token on
   `GET /ready`), restarts it after a crash (same token, same port if free; approvals pause meanwhile) and shuts it
   down with deadlines. Under `node:test` the same composition runs in-process with fakes, or in a Node child as
   the utility-process stand-in. The companion backend has its own process (see "Companion backends" above). The runtime keeps a mirror of the core's base state for its own
   decisions and synchronizes [`ShellUiState`](../apps/windows-shell/runtime/shell-ui-state.js) from it. Every window
   takes the core's state on a port of its own (the overlay: sessions and approvals, counts from the core's summary; it
   reports the revision it drew) and only main's part (`ccf:shell-state`) from main.
   Shell UI state owns onboarding, expanded approvals, the session switcher, toast and context menu.
5. [`preload.js`](../apps/windows-shell/preload.js) exposes `window.ccf`. The vanilla scripts in
   [`renderer/`](../apps/windows-shell/renderer/) receive state and invoke actions through that bridge.
   Approval actions call the controller; HTTP clients can also use `POST /approvals/:id/:action`.

## State publication

Process-split plan, step 5. Two traffic classes, never mixed:

- Replaceable frames. [`state-sync.js`](../packages/core/src/state-sync.js): `StateHub` publishes the core's state per
  subscription as versioned messages (epoch, revision, base revision): a bounded projection first (events and log are
  windows), then deltas with explicit upserts, removals, order and counts. Each subscription has a credit window of
  unacknowledged frames; while it is full, changes coalesce, and the next frame brings the subscriber to the current
  revision. [`state-mirror.js`](../packages/core/src/state-mirror.js) (browser-safe, used by main and the pages)
  ignores older revisions and epochs and asks for a resync after a gap, a newer epoch without its projection or
  counts that disagree. `FrameStream` does the same for whole frames (the companion's snapshot with its terminal).
- Lossless traffic. `LosslessQueue`: effects, `/companion/*` intents; raw PTY input has one batch in flight in the
  conversation page; commands and approval decisions are requests. Ordered, acknowledged, bounded; producers wait for
  room, nothing is dropped, a closed transport fails each item loudly.

Main's subscription rides on its endpoint (window 16; frames carry the summary of every event since the last one, so
the companion's observation of hooks survives coalescing). A window subscribes itself (`ccf:subscribe`,
[`runtime/view-subscriptions.js`](../apps/windows-shell/runtime/view-subscriptions.js)): main opens a
`MessageChannelMain`, hands one end to the core or companion utility process and posts the other to the page
(`ccf:port`; the preload passes it on by window message), so the bytes bypass main. After a service restart main posts
a new port under the same id; a page that reloads is forgotten. The page side is
[`renderer/view-subscription.js`](../apps/windows-shell/renderer/view-subscription.js) (only while visible, if asked),
and [`renderer/legacy-state.js`](../apps/windows-shell/renderer/legacy-state.js) composes a page's state from its port and
main's part ([`renderer/overlay-state.js`](../apps/windows-shell/renderer/overlay-state.js) for the overlay: live sessions,
counts); while main says the core is restarting, the old core's approvals are not shown.
The dashboard holds the newest 50 events and asks for history on demand; diagnostics holds the base state and reads
the log, hook diagnosis, settings and mascots on demand. Under the Node stand-in (tests, load fixture) the port is one
end of a loopback socket pair handed to the forked child. Since step 7 main sends no window the core's state
(`ccf:state` and `ccf:get-state` are gone) and relays no companion frame: the conversation window gets main's slim
snapshot only for the offline view after a crash and, in test mode, a marked preview. A page hot-reloaded under a main
from before step 5 gets no state at all: restart CCF.

## Main's boundary

Process-split plan, step 7. Electron's main process keeps windows, tray, hotkeys, native effects (toasts, activation,
dialogs, clipboard) and the supervision of the core and companion processes. It holds clients, never the controller,
the HookServer, a store, SQLite, node-pty or xterm, and it does no synchronous file or process work:
[`main-boundary.test.js`](../apps/windows-shell/test/main-boundary.test.js) reads every module main can load from
`main.js` (static imports, re-exports, `import()`) and fails on any of them (with the import chain that loads it). Its
own file work is asynchronous: leftover log lines on quit (an exit handler only prints them), `runtime.json`, the
mascot library with its asset cache, the cat-line catalog, the cleanup actions, the companion-folder and link checks.
Tests compose core and companion in-process through hosts the fake Electron hands over
(`core/core-in-process.js`, `companion/companion-in-process.js`); main never imports either composition.

When a permission client disconnects, the server calls `detachApprovalWaiter()`. The controller
removes that waiter and publishes state. The approval stays while another waiter exists; the last
disconnect removes it without an allow/deny response. When the core process dies, its connections drop:
the PowerShell sender exits 0 without output and Claude Code shows its own prompt; nothing is replayed.

## Persistence

Process-split plan, step 6. The core's thread keeps everything in memory and does no file work of its own: its
storage worker ([`storage-worker.js`](../packages/core/src/storage-worker.js), a worker thread inside the core process,
started by [`storage-client.js`](../packages/core/src/storage-client.js)) does. It owns the one connection to
`%APPDATA%\chaos-cat-familiar\ccf.sqlite` (`node:sqlite` from Electron's Node; WAL, `synchronous=FULL`): sessions,
notifications and events (the controller's state; changed rows batched for 100 ms, then committed by `SqliteStateStore`:
a batching delay, not a bound on what a crash loses, since a commit waiting on a slow disk holds the next batch back;
compared by [`row-shadow.js`](../packages/core/src/row-shadow.js)) and the companion's delivery records, as rows of JSON
with a position each ([`storage-schema.js`](../packages/core/src/storage-schema.js): migrations, retention, export). It
also writes `settings.json` (a plain file scripts and the hook relay read and edit: read-modify-write onto its current
content, rename retries that wait asynchronously) and watches it, appends and rotates the log, and keeps
`run-marker.json` (written when a run starts; removed only when main judged the quit clean). The core exits when its
worker dies; main restarts it.

Upgrading from a build before step 6, the first start imports `state.json` and `companion-delivery.json` once (one
transaction each, with retention and the restart resets) and moves them aside as `*.imported-<stamp>` with a
`.README.txt` (where, why, when to delete). A JSON file that appears later is never imported over the database (moved
aside as `*.not-imported-<stamp>`). The way back to an older build is the export, not those files:
`node scripts/windows/storage-export.mjs --to-json` (CCF closed) writes both from the database.

## The work companion's conversation

Normal `work-companion/start-companion.ps1` launches or focuses the cat through
`scripts/windows/open-work-companion-hud.ps1` and authenticated `POST /companion/open`.
`-Inner` still prepares the memory slot and starts Claude Code, but CCF runs it inside a
ConPTY owned by `services/companion-session.js` rather than a Windows Terminal tab.
Starting a CCF overlay by itself never launches Claude Code. Test mode rejects the Start
button and `/companion/open`; fake PTY tests and fixture smoke captures use no Claude process.

The cat is the drag anchor for separate transparent conversation and status windows. The
conversation sits above a shared footer row, with the cat on the left and status chips
to its right. Their visible content shares a horizontal centreline. Cat windows are always
168 × 144 DIP; saved bounds from an older layout or display cannot enlarge the footer.
Narrow displays fall back to a stacked footer. PTY
data feeds a headless terminal screen for interactive controls; the `Stop` hook's
`last_assistant_message` records completed replies in the session. One composer handles text
and empty-input dialog keys; the duplicate raw input, key toolbar and conversation toggle
are gone. Ctrl+numpad +/- adjusts persisted text size, and the measured terminal viewport
resizes the ConPTY so larger text reflows. The Windows dotfiles status-line
script forwards only the work-companion JSON payload through
`scripts/windows/forward-companion-statusline.ps1` to authenticated
`POST /companion/status`. CCF renders the gauges in four short rows without changing
the other Claude sessions' terminal status lines. CCF sets `CCF_HOSTED_COMPANION=1` in its
PTY; the dotfiles script checks that marker and the companion cwd, forwards the JSON, then
prints nothing. This removes only the custom status rows in the CCF-hosted companion.
Interactive mode has no documented switch to hide Claude's native prompt (see the
[status-line documentation](https://code.claude.com/docs/en/statusline) and
[CLI reference](https://code.claude.com/docs/en/cli-reference)), so the conversation renderer
drops it from the serialized viewport instead: `hideClaudePromptBox()` in
`renderer/companion-terminal.js` removes the blank spacer, both rules and an empty `❯` row
near the bottom. Anything else (dialogs, menus, real pending input) is drawn unchanged.
The conversation and four-row status windows
activate only for the work companion. The cat has no state/session badge; its right-click opens the shared companion menu (see "The side panel and
the cluster menu"), and the tray and dashboard retain the other controls.

All cluster windows use one explicit always-on-top level (`pop-up-menu`) while Always on Top is on. Electron's
default `floating` level re-inserts a window below the taskbar on every activation, and
Windows drops the topmost bit whenever the taskbar is not topmost at that moment, which let
a maximized app cover clicked panels. A 2-second watchdog restores any lost topmost bit and
logs `Companion window lost always-on-top`. Focusing the cat raises the whole cluster; the
toggle hotkey and the tray's "Bring Companion to Front" summon a buried cluster.

Speech bubbles: the work companion's watcher posts `POST /companion/bubble` (`{text}`) when a
session waits on the user, alongside its meow. `services/companion-bubbles.js` keeps the
stack (oldest dropped past 50) and rolls each bubble's style (six, `renderer/companion-bubble.css`)
and a 1-in-7 special entrance. One transparent, non-focusable window
(`renderer/companion-bubble.*`, placed by `services/companion-bubble-layout.js`) sits above
the cat with the newest bubble's tail on its head, shows the newest three plus a "+N" count,
and exists only while a bubble does. It is click-through except over a bubble (the renderer
reports the pointer); a click dismisses that bubble. It hides and moves with the cat and is
stacked last in the cluster, above the conversation. `style` and `special` in the request
override the roll.

The watcher normally names an event instead of sending text: `{event: "agent_idle",
placeholders: {agent, mins}}`. `services/cat-lines.js` picks the line from Wolfram's catalog,
`assets/cat-lines.json` (his text; its `meta` block is the spec): a tier by weight (70/22/7/1),
an empty tier falls back to the next lower one, a line whose placeholders were not all sent
counts as missing, lore replaces any bubble at legendary weight, and inside `meta.night_window`
(22:00-05:00 local) a night line replaces a common one at `replace_chance`. Legendary and lore
lines force the special entrance. Text sent along with an event is the fallback for an event the
catalog lacks; an unknown event without text is a 400 (`unknown_bubble_event`). Free text
alone still works: the companion writes its own greeting bubble that way.

Development runs use `services/design-reload.js` to watch renderer files with debounced
filesystem events. CSS links swap after their replacements load; HTML and JavaScript saves
reload the views. `renderer/design-reload.js` restores unsent fields, caret, focus and scroll
from session storage. The companion process owns the PTY and transcript, main the latest status, throughout.
Packaged builds do not watch files. Preload and backend changes still need a restart.
The headless terminal also serializes ANSI cell styles through `services/terminal-screen.js`;
the renderer builds safe coloured spans instead of discarding colours from the screen.
PTY bytes enter the parser immediately; terminal snapshots are coalesced on a 33 ms timer and leave as replaceable
frames on the conversation window's own port (two unacknowledged at most, then only the newest).
Exit waits for accepted parser writes before publishing the final screen. Snapshot revisions let
metadata-only updates reuse normalized terminal rows, while older full snapshots remain supported.
The renderer retains unchanged DOM rows, including shifted scrollback, instead of rebuilding the
entire conversation for a spinner repaint. There is no cache keyed by xterm's disposable line wrappers.

Claude Code wraps its text to the pane itself and sends explicit newlines, so xterm's `isWrapped` never marks
those rows. `renderer/terminal-text.js` (pure, rules at its top) rebuilds the logical lines from the row text: a
row continues the one above when it is indented to that row's text start, starts no list item, table or tool
result, and its first word would not have fit the wrap width (the longest row with the same text start, at least
the pane width minus 6). The renderer uses it twice: `linkPlainUrls` turns plain http(s) and `file://` URLs
into the same link spans OSC 8 links get, following a URL across such a cut; the pane's `copy` handler
(`terminalSelectionText`) puts the selected rows on the clipboard joined, without padding and shared indentation.

`services/terminal-screen.js` also serializes up to 1,000 scrollback rows. The renderer follows
new output only when already near the bottom. The companion launcher sets
`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` after its inherited-Claude-environment cleanup,
and only for `CCF_HOSTED_COMPANION=1`; terminal-only starts keep their existing renderer.
See Claude's [environment variable reference](https://code.claude.com/docs/en/env-vars).

`services/companion-attachments.js` owns staged PNG/JPEG/GIF/WebP copies (eight per message,
20 MB each). Ctrl+V and drop supply image data; Attach uses Electron's file chooser, and
Alt+V reads the native image clipboard (main keeps the chooser and the clipboard). The companion process returns
opaque IDs and thumbnail URLs, retains pending images across renderer reloads (not across a companion crash; an
uncertain Codex send's images are restored), and appends selected file paths to
the PTY message using Claude's supported
[image-file workflow](https://code.claude.com/docs/en/common-workflows#work-with-images).
Failed sends retain the pending images. Removing an unsent image deletes its copy; successful
sends retain their copies under `%APPDATA%\chaos-cat-familiar\companion-attachments\` because
saved conversation references need them. Full CCF app-data removal deletes those files too.

## The side panel and the cluster menu

Read before changing the side panel, the cluster's topmost handling, the tray or the cat's menu; update in the same
commit.

The side panel is a fourth cluster window: frameless, transparent, not focusable (a click must not take keyboard focus
from his editor or the composer), 320 DIP wide, left of the conversation with the same top and height
([`companion-cluster-layout.js`](../apps/windows-shell/services/companion-cluster-layout.js), `PANEL`; on a work area
narrower than the conversation + 320 + 16 there is none, and the cat is clamped 320 further from the left edge while
it shows). It shows with the cluster while the setting `sidePanelVisible` is on (default), toggled by the menu's
"Side Panel" checkbox.

CCF knows nothing about what the panel says. It renders one JSON file, schema `ccf-side-panel/1`, defined, validated
and capped by [`renderer/companion-panel-model.js`](../apps/windows-shell/renderer/companion-panel-model.js) (the schema
is the code there; invalid sections, items, links and session ids are dropped and counted, the header shows
"· N dropped"). The work companion writes it (`tools/panel.py` in the work-companion repo, refreshed by its watcher;
that docstring says what each section holds). File: the setting `sidePanelFile` (absolute), else
`<companionDataPath ?? companionRepoPath>/state/panel.json`.

```
companion watcher ──► <companion>/state/panel.json (atomic replace)
                         │ fs.promises.stat every 2 s while the panel shows; readFile only on an mtime/size change
main: SidePanelFeed ── normalizePanel ──► {status, panel, dropped, error, file, checkedAt, changedAt}
                         │ ccf:side-panel, only when it changed; ccf:get-side-panel on load
panel page (companion-panel.js) ── freshness from generatedAt/staleAfterSec, ages re-rendered every 30 s
                         │ window.ccf.sidePanelAction({action, …}) → main: openLink / clipboard / focusSession / panel-done.jsonl
```

[`SidePanelFeed`](../apps/windows-shell/services/side-panel-feed.js) runs only while the panel window shows, one poll in
flight at a time; statuses `unconfigured`, `missing`, `ok`, `invalid` (over 64 KiB, not JSON, not a panel). A file that
fails to parse while its mtime is under 2 s old is read again once (a writer mid-replace); a failed stat or read (a
scanner's lock) is retried at every poll, and only content read in full and found malformed stays `invalid` until the
file changes. After an `ok`, `missing`
and `invalid` keep the last good panel, shown dimmed. Past `staleAfterSec` the page dims the list and turns the header
amber; a section whose source is stale shows ⚠ and its note. A row click raises the session's terminal window (`session`,
looked up in the core's sessions; Windows Terminal tabs and panes cannot be selected, so the flash says "window raised"
unless the exact tab was confirmed; no window: "no terminal window found", never a new terminal; an ended session:
"session has ended"), else opens the link, else copies. An item with a `done` key (a plain token, `[A-Za-z0-9:@._+-]`,
≤ 160) shows a ✓ button; a click is `mark-done`: main appends `{"at", "key", "text"}` as one line to `panel-done.jsonl`
next to the panel file, and the page dims the row until a panel file without that key arrives. CCF gives the key no
meaning; the companion's watcher reads the file (his ask 2026-11-19: signal "this session is done" without typing it).
Tree look (2026-11-23, his ask): `kind: "heading"` makes a row a group heading, `depth` 1..2 indents a row with a
soft guide line; both are presentation only, anything else is ignored.
Links open through `openLink()` in the runtime,
shared with the conversation's OSC 8 links: http(s) in the browser; a local file only when it is a folder or one of the
document types in `OPENABLE_FILE_TYPES` (text, Markdown, data, HTML, PDF, images, Office files without macros), opened
in its default app. Everything else is refused (`refusedFileReason()`), also trailing dots, alternate data streams
and `x.{CLSID}` folders. It is an allowlist because `openPath` runs whatever the extension is associated with, the
file is written by an LLM-driven process, and a list of refused types missed `.py`/`.pyw` (review 2026-11-17). Add a
type there only if its default handler never runs code. The page draws text with `textContent` only.

One menu definition, [`services/companion-menu.js`](../apps/windows-shell/services/companion-menu.js), serves the tray
and the cat's right-click in mascot mode (`ccf:show-companion-menu`, popped on the cat window; not during a drag;
developer mode keeps its controls panel): Show Companion, Always on Top, Side Panel, Minimize to Tray, Dashboard,
Settings; the tray adds Mascots, Advanced and Quit. Quit is not on the cat: it ends the companion's session.

Always on Top (setting `clusterAlwaysOnTop`, default on) covers the whole cluster: cat, conversation, status, panel,
bubbles. Off, every cluster window is an ordinary window, the 2-second watchdog and the blur repair stand down (they
would undo the choice), a cat click raises the cluster with `moveTop()` in stack order (status, panel, conversation,
cat, bubbles), and a new bubble raises the cat and the bubbles once. Every path that changes the setting (the menu,
`ccf:update-settings`, the core's push of an outside edit, a core restart) goes through `syncClusterTopmostSetting()`,
which applies a transition to every cluster window and the watchdog.

Minimize to Tray (`minimizeToTray()`, formerly Hide Companion) hides the cat, conversation, status, panel and bubbles,
stops the panel's feed and saves `overlayVisible: false`, so it persists across restarts. While minimized in mascot
mode, an approval's `show-overlay` effect no longer shows the cat (it cannot answer approvals there; checked when the
show runs, after any wait for the overlay's revision report, so a minimize during that wait holds); new bubbles stack
hidden; the tray tooltip counts both ("Chaos Cat Familiar · 1 approval · 2 waiting") and the menu reads "Show Companion
· 3 waiting". Toasts still fire. The tray click, Show Companion, the summon hotkey, the launcher, a toast click and a
second instance bring it back. In developer mode an approval still shows the overlay.

The cat's `overlay.js` calls `window.ccf.showCompanionMenu?.()` with optional chaining, so a page hot-reloaded under an
older preload does nothing instead of throwing. Smoke: `scripts/windows/side-panel-smoke.mjs`, run by the main smoke
after the companion block (`CCF_SMOKE_SKIP_SIDE_PANEL=1` skips it); test-mode routes `/menu-click {surface, id}`,
`/capture-companion-panel`, and `cluster` (per window `kind`, visible, bounds, alwaysOnTop) plus `sidePanel` in
`/diagnostics-summary`. A capture run (`CCF_SMOKE_COMPANION_CAPTURE_DIR`) needs `CCF_SMOKE_SKIP_COMPANION=1` too: the
capture preview opens the conversation, whose first read starts the companion before the companion block's lazy-start
check. Not built yet: an "On others" section, Active rows from CCF's own hook-fed sessions (decided against for now,
2026-11-17, after an assessment in the companion's own repository), panel text following the
conversation's size, a badged tray icon while minimized, the panel on the right when the cat sits at the left edge.

## Where to make a change

| Concern | Start here | Tests |
| --- | --- | --- |
| Hook fields and validation | `packages/core/src/models.js`, `hook-validator.js`, `contracts/` | `packages/core/test/core.test.js` |
| Sessions, approvals, notifications | `packages/core/src/*-store.js`, `notification-router.js`, `core-controller.js` | `packages/core/test/core.test.js` |
| Windows, tray, IPC, lifecycle | `apps/windows-shell/runtime/windows-shell-runtime.js` | `apps/windows-shell/test/windows-shell-runtime.test.js` |
| State publication, view ports | `packages/core/src/state-sync.js`, `state-mirror.js`, shell `runtime/view-subscriptions.js`, `renderer/view-subscription.js`, `renderer/legacy-state.js`, `renderer/overlay-state.js` | `packages/core/test/state-sync.test.js` (a really stalled consumer thread), `view-ports.test.js`, `view-subscription.test.js`, `overlay-revision.test.js`, `diagnostics-view.test.js`, `dashboard-approvals.test.js`, `load-fixture.test.js` |
| Persistence (SQLite, settings file, log, run marker) | `packages/core/src/storage-worker.js`, `storage-client.js`, `storage-schema.js`, `row-shadow.js`, `companion-delivery.js`, `scripts/windows/storage-export.mjs` | `storage.test.js`, `storage-crash.test.js` (real processes killed mid-commit and mid-send), `companion-delivery.test.js`, `settings-authority.test.js`, shell `runtime-persistence.test.js`, `storage-export.test.mjs` |
| Core/companion service boundary | `packages/core/src/service-rpc.js`, `core-service.js`, `core-client.js`, `process-ports.js`, `settings-authority.js`, shell `core/` and `services/companion-service.js` | replay fixtures (`packages/core/test/replay.test.js`, shell `runtime-replay.test.js`, each also against a core in a child process), `core-service.test.js`, `core-process.test.js`, `runtime-core-process.test.js`, `companion-service.test.js` |
| Companion process | `apps/windows-shell/companion/` (entrypoint, composition, host, kill-on-close job), `services/companion-service.js` | `companion-composition.test.js`, `companion-process.test.js` and `runtime-companion-process.test.js` (real node-pty, PowerShell fixture in `test-support/companion-fixture/`), `companion-service.test.js` |
| Main-thread load and stalls | `services/event-loop-monitor.js`, `test-support/load-fixture.js` (`npm run load:windows-shell`) | `load-fixture.test.js`, `event-loop-monitor.test.js` |
| Side panel, cluster menu, Always on Top, Minimize to Tray | `renderer/companion-panel*.{js,css,html}`, `renderer/companion-panel-model.js`, `services/side-panel-feed.js`, `services/companion-menu.js`, `services/companion-cluster-layout.js`, the runtime | `companion-panel-model.test.js`, `side-panel-feed.test.js`, `companion-menu.test.js`, `companion-cluster-layout.test.js`, `runtime-side-panel.test.js`, `runtime-tray.test.js`; `npm run smoke:windows-shell` (`scripts/windows/side-panel-smoke.mjs`) |
| UI commands and transient state | `apps/windows-shell/runtime/shell-ui-state.js` | `apps/windows-shell/test/shell-ui-state.test.js` |
| Hooks, OS activation and notifications | `apps/windows-shell/services/platform-services.js` | `apps/windows-shell/test/platform-services.test.js` |
| Mascots and animation selection | `services/mascot-library.js`, `renderer/mascot-state-machine.js` under the shell | corresponding shell test files |
| Editor terminal helper | [`extensions/vscode/README.md`](../extensions/vscode/README.md) | manual editor check |
| Main's boundary (no stores, no sync file work) | `apps/windows-shell/main.js` and what it imports | `main-boundary.test.js`, `runtime-features.test.js` |
| Packaging | [`packaging/windows/README.md`](../packaging/windows/README.md), `scripts/windows/stage-electron-app.mjs` | `stage-electron-app.test.mjs`; `CCF_SMOKE_APP=<exe> npm run smoke:windows-shell`; installed MSIX validation remains outstanding |

The hook-event schema documents the input shape; the server uses the separate JavaScript validator.
Keep both aligned when changing the contract. `permission-response.examples.json` contains examples,
not a response schema.

## Safe local runs

`npm test` uses fakes for Electron (the core in-process, or in a Node child where a test asks for a real
process; the companion in a Node child with real node-pty and a PowerShell fixture). `npm run smoke:windows-shell`
runs Electron with a throwaway profile, checks that the core runs as a utility process, kills it once to check the
restart, starts the companion process with the PowerShell fixture (never Claude), kills it, restarts it with Start,
and exits. With `CCF_SMOKE_APP` set to a packaged `ChaosCatFamiliar.exe` it runs the same checks against that build. A normal app launch installs hooks in the real Claude profile; see [AGENTS](../AGENTS.md)
for overrides when running interactively against temporary data.
Test mode also suppresses Windows toasts and skips protocol registration, login-item changes and
global hotkeys.
