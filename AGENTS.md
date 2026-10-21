# AGENTS.md

Chaos Cat Familiar (CCF): a Windows desktop familiar for Claude Code sessions.
Claude Code only: Codex and Copilot support was removed on purpose (2026-10-16); don't add it back.
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
```

## Architecture

npm workspaces monorepo. Core is platform-neutral; the shell is Windows/Electron.

- **`packages/core/`**: hook ingestion, session tracking, approval state machine, notification routing,
  settings, HTTP hook server. No Electron imports.
- **`apps/windows-shell/`**: Electron shell. `main.js` is a thin bootstrap; the app lives in
  `runtime/windows-shell-runtime.js` (windows, tray, IPC, hotkeys) and `runtime/shell-ui-state.js`.

### Core (`packages/core/src/`)

- **`CcfCoreController`**: orchestrator. Platform services (overlay, notifier, stateStore, settings,
  activation, terminalLocator, hookInstaller, logger) are constructor-injected. Emits `change`
  with `(snapshot, lastEvent)`; the shell subscribes to synchronize its UI.
- **`HookServer`**: HTTP on `127.0.0.1`, port `49152` by default (configurable; shell falls back to a free port).
  `GET /health`, `GET /state`, `POST /hook`,
  `POST /approvals/:id/:action`, authenticated `POST /companion/open` and
  `POST /companion/status` for the work companion HUD.
- **`platform-service-contracts.js`**: abstract bases the shell implements.
- **`models.js`**: `normalizeEvent()` turns snake_case hook payloads into camelCase.
- **`contracts/`**: hook-event JSON Schema and permission-response examples. Runtime validation is
  implemented separately in `hook-validator.js`.

### Shell (`apps/windows-shell/`)

- **`services/platform-services.js`**: Electron implementations of the core contracts. Editor/terminal
  activation via PowerShell + Win32 `SetForegroundWindow`.
- **`services/ccf-protocol.js`**: `ccf://` deep links.
- **`services/companion-session.js`**: explicit-start work-companion ConPTY transport;
  tests inject a fake PTY and must never start Claude Code.
- **`renderer/`**: HTML + vanilla JS, no bundler. **`preload.js`** exposes `window.ccf`.

### Hooks

`ElectronHookInstallationService` writes hooks into `~/.claude/settings.json`. They run the generated
`~/.chaos-cat-familiar/hooks/hook-sender.ps1`, which forwards events to the hook server. Permission
requests block; everything else is fire-and-forget. Removal only touches entries that reference that
sender.

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
