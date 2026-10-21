# Finding your way around CCF

Read [README](../README.md) for running the app, [STATUS](STATUS.md) for current work and limitations,
and [AGENTS](../AGENTS.md) for commands and conventions. The core has no Electron dependency;
the shell injects its platform services.

## A hook's path to the screen

1. Normal startup calls `bootstrapClaudeHooks()` in
   [`windows-shell-runtime.js`](../apps/windows-shell/runtime/windows-shell-runtime.js).
   [`ElectronHookInstallationService`](../apps/windows-shell/services/platform-services.js) writes
   Claude settings atomically and generates the PowerShell sender for the active local port/token.
   Routine hooks use Claude-managed async execution; permission requests stay synchronous
   (130-second hook timeout, 120-second HTTP timeout). Worktree lifecycle hooks are not installed.
2. The sender posts to [`HookServer`](../packages/core/src/hook-server.js). The server checks the
   loopback Host, rejects browser Origins, and requires `X-Ccf-Token` except on `/health`.
   The per-install token lives in CCF settings and the generated sender. It then checks the
   payload with [`hook-validator.js`](../packages/core/src/hook-validator.js), then
   [`normalizeEvent()`](../packages/core/src/models.js) converts snake_case fields to camelCase.
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
Claude's native prompt and built-in footer remain: interactive mode has no documented
switch to hide those. See the [status-line documentation](https://code.claude.com/docs/en/statusline)
and [CLI reference](https://code.claude.com/docs/en/cli-reference).
The conversation and four-row status windows
activate only for the work companion. The cat has no state/session badge or right-click panel;
the tray and dashboard retain those controls.

Development runs use `services/design-reload.js` to watch renderer files with debounced
filesystem events. CSS links swap after their replacements load; HTML and JavaScript saves
reload the views. `renderer/design-reload.js` restores unsent fields, caret, focus and scroll
from session storage. The main process owns the PTY, transcript and latest status throughout.
Packaged builds do not watch files. Preload and backend changes still need a restart.
The headless terminal also serializes ANSI cell styles through `services/terminal-screen.js`;
the renderer builds safe coloured spans instead of discarding colours from the screen.

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
