# AGENTS.md

Chaos Cat Familiar (CCF): a Windows desktop familiar for Claude Code sessions.
Claude Code is the default. The companion pane can also run Codex (`codex app-server` with the
user's own config), and Codex hooks feed session observation (2026-10-28). Copilot stays out.
Standalone project; it started as a port of Masko Code v0.12.0 but no longer tracks upstream.
State of play and the next step: `docs/STATUS.md`.
Hook-to-renderer walkthrough and file map: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Commands

```bash
npm test                                    # all tests
npm run test:core                           # core package only
npm run test:windows-shell                  # windows shell only
node --test packages/core/test/core.test.js # single file
npm run start:windows-shell                 # launch the Electron app
npm run smoke:windows-shell                 # isolated smoke run, exits on its own
npm run load:windows-shell                  # load fixture in real time (~3 min, temp data), result as JSON
```

## Architecture

npm workspaces monorepo. Core is platform-neutral; the shell is Windows/Electron.

- **`packages/core/`**: hook ingestion, session tracking, approval state machine, notification routing,
  settings, HTTP hook server. No Electron imports.
- **`apps/windows-shell/`**: Electron shell. `main.js` is a thin bootstrap; the app lives in
  `runtime/windows-shell-runtime.js` (windows, tray, IPC, hotkeys) and `runtime/shell-ui-state.js`.
  The core (HookServer, approvals, settings, log file, state database, hook files) runs in an Electron
  utility process: `core/core-process.js` (entrypoint), `core/core-composition.js`, `core/core-host.js`
  (boot, crash restart, shutdown). Main keeps no stores, reads settings from a mirror and does no synchronous file
  work; `test/main-boundary.test.js` checks every module main loads (keep it green: no store, SQLite, node-pty,
  xterm or `*Sync(` call in main's import graph). The core's file work
  happens in its storage worker (`packages/core/src/storage-worker.js`, a worker thread): `ccf.sqlite` (`node:sqlite`,
  WAL; state and companion delivery records as rows), `settings.json` writes and watching, the log, the run marker.
  `node scripts/windows/storage-export.mjs` exports the database as the JSON files an older build reads.
  The companion backend (Claude PTY, Codex, habitat, watcher, delivery records via the core, attachments) runs in a second
  utility process, started when the companion is first needed: `companion/companion-process.js`,
  `companion/companion-composition.js`, `companion/companion-host.js` (lazy start, no automatic restart after a
  crash, shutdown). Before its first child it joins a kill-on-close job (`companion/process-tree.js`), so its
  children end with it; without the job it starts none.
  State reaches windows as versioned deltas and frames (`packages/core/src/state-sync.js`, `state-mirror.js`); every
  window (overlay, dashboard, diagnostics, conversation) gets them on a MessagePort of its own that main sets up
  (`runtime/view-subscriptions.js`, `renderer/view-subscription.js`), so main relays no state and no terminal frame.
  Packaged build: `npm run packaging:windows:prepare-app -- -RunPackager` stages the app (`scripts/windows/stage-electron-app.mjs`);
  `CCF_SMOKE_APP=<exe> npm run smoke:windows-shell` checks it.

### Core (`packages/core/src/`)

- **`CcfCoreController`**: orchestrator. Platform services (overlay, notifier, stateStore, settings,
  activation, terminalLocator, hookInstaller, logger) are constructor-injected. Emits `change`
  with `(snapshot, lastEvent)`; the shell subscribes to synchronize its UI.
- **`HookServer`**: HTTP on `127.0.0.1`, port `49152` by default (configurable; shell falls back to a free port).
  `GET /health`, `GET /state`, `POST /hook`,
  `POST /approvals/:id/:action`, authenticated `POST /companion/open` and
  `POST /companion/status` for the work companion HUD, and `POST /companion/bubble`
  (`{text}` or `{event, placeholders?, text?}`, plus `style?`, `special?`) for the cat's speech bubbles.
- **`platform-service-contracts.js`**: abstract bases the shell implements.
- **`models.js`**: `normalizeEvent()` turns snake_case hook payloads into camelCase.
- **`contracts/`**: hook-event JSON Schema and permission-response examples. Runtime validation is
  implemented separately in `hook-validator.js`.

### Shell (`apps/windows-shell/`)

- **`services/platform-services.js`**: Electron implementations of the core contracts. Editor/terminal
  activation via PowerShell + Win32 `SetForegroundWindow`.
- **`services/ccf-protocol.js`**: `ccf://` deep links.
- **`services/companion-session.js`**: explicit-start work-companion ConPTY transport (runs in the companion
  process); tests inject a fake PTY or use the PowerShell fixture in `test-support/companion-fixture/` and must never
  start Claude Code. In test mode the Start action runs only `CCF_TEST_COMPANION_FIXTURE`.
- **`renderer/`**: HTML + vanilla JS, no bundler. **`preload.js`** exposes `window.ccf`.

### Hooks

`ElectronHookInstallationService` writes hooks into `~/.claude/settings.json` in two forms:

- `SessionStart`, `UserPromptSubmit`, `PermissionRequest`: a command hook running the generated
  `~/.chaos-cat-familiar/hooks/hook-sender.ps1`. SessionStart accepts no http hooks, and the sender
  adds `shell_pid` to exactly these three. Permission requests block (timeout 130); the other two are async.
- Every other event: a Claude Code http hook (`type: "http"`, `http://127.0.0.1:<port>/hook`,
  `X-Ccf-Token` header, timeout 5), with no process per event. A 30-minute ETW capture
  (2026-11-02) counted 712 sender starts, each behind two Git Bash processes, ~2.6 s and ~0.7 CPU-s apiece.

Http hooks are synchronous, so `POST /hook` answers routine events right after validation and
ingests them afterwards on a serial chain (`HookServer.idle()` waits for it). CCF owns a command
that references the sender, and an http hook whose url is `http://127.0.0.1:<any port>/hook` with
an `X-Ccf-Token` header (`claude-hook-cleanup.js`). Removal and drift checks touch only those;
a changed port or token counts as drift and is rewritten.

Hook relay (`apps/hook-relay/`, Go, 2026-11-02): with `hookRelayPort` set in CCF settings (49151 on the
operator's machine), the routine http hooks point at `ccf-hook-relay.exe` instead of CCF. The relay starts
at logon (task `ccf-hook-relay`), answers `200 {}` at once and forwards each event to CCF in order, dropping it
silently while CCF is closed. Why: Claude Code shows a "hook error / ECONNREFUSED" notice for every failed http
hook and cannot hide it, so a closed CCF filled every session's transcript. `hookRelayPort: null` (default) keeps
the direct hooks. Build and task: `pwsh apps/hook-relay/build.ps1 -InstallTask`; tests: `go test` there.

Starting the app installs or repairs these hooks in the real `~/.claude/settings.json` (`bootstrapClaudeHooks`
in the runtime). For any test run, use `npm run smoke:windows-shell` or set `CCF_HOME_OVERRIDE` and
`CCF_APPDATA_OVERRIDE` to temp dirs: the hooks then land in the temp home, and `CCF_TEST_MODE=1`
also keeps Windows toasts quiet.
Test mode skips protocol registration, login-item changes and global hotkeys as well.

## Conventions

- ESM with `.js` extensions in imports; Electron's sandboxed preload and the VS Code helper use CommonJS
- No transpilation or bundling: plain Node.js + vanilla browser JS
- Tests: `node:test` + `node:assert/strict`, fakes inline (`apps/windows-shell/test-support/fake-electron.js`)
- TDD: write the failing test first
- Constructor injection for all platform services
- snake_case hook payloads become camelCase at the `normalizeEvent()` boundary
- Windows platform calls via PowerShell through `child_process.execFile`
- `chaos-cat` is the bundled default mascot. The other mascot configs, including slug `masko`
  and their `assets.masko.ai` URLs, are upstream art; leave those names and URLs intact.
