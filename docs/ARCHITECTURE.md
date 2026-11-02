# Finding your way around CCF

Read [README](../README.md) for running the app, [STATUS](STATUS.md) for current work and limitations,
and [AGENTS](../AGENTS.md) for commands and conventions. The core has no Electron dependency;
the shell injects its platform services.

## Companion backends

`CompanionBackends` selects Claude or Codex, guarding active work during switches.
Claude retains `companion-session.js` and its PTY view. Codex uses
`codex-json-rpc.js`, `codex-companion-session.js` and a hidden stdio child process
from `codex-process-transport.js`, inheriting normal user configuration and environment.
There is no native supervisor or production resource ceiling.

`companion-structured.js` renders messages, grouped system updates and approval forms.
The runtime clears matching draft/attachment revisions after backend acceptance.
`CompanionDeliveryStore` stores conversation identity, outcomes and optional watcher
receipts in atomic JSON; Electron already provides the single-instance lock.
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
   final checkpoint.
3. [`CcfCoreController`](../packages/core/src/core-controller.js) records sessions, derives
   notifications and manages approvals through its stores. A permission request keeps its HTTP
   connection open until answered or dismissed. Duplicate requests share an approval but have
   separate waiter IDs.
4. The controller emits `change(snapshot, lastEvent)`. The runtime subscribes, synchronizes
   [`ShellUiState`](../apps/windows-shell/runtime/shell-ui-state.js), and sends `ccf:state` over IPC.
   Shell UI state owns onboarding, expanded approvals, the session switcher, toast and context menu.
5. [`preload.js`](../apps/windows-shell/preload.js) exposes `window.ccf`. The vanilla scripts in
   [`renderer/`](../apps/windows-shell/renderer/) receive state and invoke actions through that bridge.
   Approval actions call the controller; HTTP clients can also use `POST /approvals/:id/:action`.

When a permission client disconnects, the server calls `detachApprovalWaiter()`. The controller
removes that waiter and publishes state. The approval stays while another waiter exists; the last
disconnect removes it without an allow/deny response.

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
activate only for the work companion. The cat has no state/session badge or right-click panel;
the tray and dashboard retain those controls.

All three cluster windows use one explicit always-on-top level (`pop-up-menu`). Electron's
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
from session storage. The main process owns the PTY, transcript and latest status throughout.
Packaged builds do not watch files. Preload and backend changes still need a restart.
The headless terminal also serializes ANSI cell styles through `services/terminal-screen.js`;
the renderer builds safe coloured spans instead of discarding colours from the screen.
PTY bytes enter the parser immediately; terminal snapshots are coalesced on a 33 ms timer.
Exit waits for accepted parser writes before publishing the final screen. Snapshot revisions let
metadata-only updates reuse normalized terminal rows, while older full snapshots remain supported.
The renderer retains unchanged DOM rows, including shifted scrollback, instead of rebuilding the
entire conversation for a spinner repaint. There is no cache keyed by xterm's disposable line wrappers.

`services/terminal-screen.js` also serializes up to 1,000 scrollback rows. The renderer follows
new output only when already near the bottom. The companion launcher sets
`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` after its inherited-Claude-environment cleanup,
and only for `CCF_HOSTED_COMPANION=1`; terminal-only starts keep their existing renderer.
See Claude's [environment variable reference](https://code.claude.com/docs/en/env-vars).

`services/companion-attachments.js` owns staged PNG/JPEG/GIF/WebP copies (eight per message,
20 MB each). Ctrl+V and drop supply image data; Attach uses Electron's file chooser, and
Alt+V reads the native image clipboard. The main process returns opaque IDs and thumbnail
URLs, retains pending images across renderer reloads, and appends selected file paths to
the PTY message using Claude's supported
[image-file workflow](https://code.claude.com/docs/en/common-workflows#work-with-images).
Failed sends retain the pending images. Removing an unsent image deletes its copy; successful
sends retain their copies under `%APPDATA%\chaos-cat-familiar\companion-attachments\` because
saved conversation references need them. Full CCF app-data removal deletes those files too.

## Where to make a change

| Concern | Start here | Tests |
| --- | --- | --- |
| Hook fields and validation | `packages/core/src/models.js`, `hook-validator.js`, `contracts/` | `packages/core/test/core.test.js` |
| Sessions, approvals, notifications | `packages/core/src/*-store.js`, `notification-router.js`, `core-controller.js` | `packages/core/test/core.test.js` |
| Windows, tray, IPC, lifecycle | `apps/windows-shell/runtime/windows-shell-runtime.js` | `apps/windows-shell/test/windows-shell-runtime.test.js` |
| UI commands and transient state | `apps/windows-shell/runtime/shell-ui-state.js` | `apps/windows-shell/test/shell-ui-state.test.js` |
| Hooks, OS activation and notifications | `apps/windows-shell/services/platform-services.js` | `apps/windows-shell/test/platform-services.test.js` |
| Mascots and animation selection | `services/mascot-library.js`, `renderer/mascot-state-machine.js` under the shell | corresponding shell test files |
| Editor terminal helper | [`extensions/vscode/README.md`](../extensions/vscode/README.md) | manual editor check |
| Packaging | [`packaging/windows/README.md`](../packaging/windows/README.md) | installed-build validation remains outstanding |

The hook-event schema documents the input shape; the server uses the separate JavaScript validator.
Keep both aligned when changing the contract. `permission-response.examples.json` contains examples,
not a response schema.

## Safe local runs

`npm test` uses fakes for Electron. `npm run smoke:windows-shell` runs Electron with a throwaway
profile and exits. A normal app launch installs hooks in the real Claude profile; see [AGENTS](../AGENTS.md)
for overrides when running interactively against temporary data.
Test mode also suppresses Windows toasts and skips protocol registration, login-item changes and
global hotkeys.
