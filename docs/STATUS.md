# Status

As of 2026-10-27. Dev-run only: no installer, no packaged build has been tested.

## Where it stands

- The tray now uses a purple pixel cat ICO with Windows DPI sizes. Show/Hide Companion
  controls the complete cluster without starting or stopping Claude; Settings opens
  directly in the dashboard. Diagnostics, preview and mode choices live under Advanced.
  Explicit mode choices override launch defaults, menu errors are reported, and the
  dashboard has draggable minimize/maximize/close controls.
- Mascot dragging saves its position on release, keeping settings file I/O out of
  movement frames. Cluster bounds are calculated before moving the windows, avoiding
  edge bounce. Temporary settings-file locks retain and retry the latest position
  instead of closing CCF; fatal JavaScript errors show a dialog with the log path.
- State checkpoints and ordinary file logs batch over 250 ms, with bounded log buffers
  and an unclean-run marker. Terminal snapshots coalesce over 33 ms; the renderer
  retains unchanged rows and scrollback instead of rebuilding them on each update.
- The full serial test suite passes 308 tests; the isolated Electron smoke test passes.
- Core (`packages/core`): hook server, sessions, approvals, notification routing. Covered by automated tests; real Claude-session validation remains outstanding.
- Shell (`apps/windows-shell`): tray, overlay, dashboard, diagnostics, mascots. Claude Code
  only; Codex and Copilot support was cut on 2026-10-16. Runs with `npm run start:windows-shell`.
- Chaos Cat Familiar v0.3 is the bundled default mascot: four local transparent loops and all
  12 directed handoffs. Existing profiles using the former bundled Masko default migrate once;
  explicitly selected alternatives remain selected. Visible Idle and approval states now animate
  for this mascot; hidden overlays still release video decoding.
- The work companion now has cat-anchored conversation and four-row status HUDs. The
  normal companion launcher hands off to CCF; its `-Inner` Claude startup runs inside
  CCF's PTY only after an explicit Start or launcher request. Fake PTY, PowerShell relay,
  runtime and isolated Electron smoke checks run without starting Claude Code. Full live
  approval coverage is still pending.
- `npm test` runs core and shell tests. `npm run smoke:windows-shell` starts the shell against a throwaway
  profile and exits.
- Development renderer saves now hot-reload without restarting the companion. Drafts and view
  position survive full view reloads. The conversation has separate borderless content and
  input surfaces, a coloured terminal screen and thin transparent-track scrollbars. The cat's
  state/session badge and the retired right-click controls popup have been removed.
- The cat and four status rows share the space directly below the conversation: cat left,
  chips right, with their visible centres aligned and a clear gap. Cat windows no longer
  retain old badge space or inflated saved dimensions.
- The companion has one composer under the live terminal. Ctrl+numpad +/- changes text size
  (14 px default), Ctrl+0 resets it, and the terminal reflows. CCF-hosted companion sessions
  suppress their duplicate custom status line while continuing to feed the status chips.
  The conversation view hides Claude's own idle input box (spacer, rules, `❯` row) and
  keeps the mode line; dialogs, menus and a box holding real input still render in full.
- Images can be pasted, dropped or selected with Attach, previewed and removed before sending.
  Image-only messages work. Pending thumbnails survive design reloads; sent files remain in
  CCF's app-data attachment folder for later reads by the session.
- The terminal now renders up to 1,000 styled scrollback lines and preserves a scrolled-up
  reading position. The companion launcher disables Claude's alternate screen only when
  hosted by CCF, so conversation output reaches that history.
- Panels no longer fall behind maximized apps while the cat stays on top (2026-10-22). The
  cat and panels share one explicit topmost level, and a watchdog restores and logs lost
  topmost bits. Escape hatches: click the cat, press Ctrl+Shift+Space (it summons an
  unfocused companion and hides a focused one), or use the tray's "Bring Companion to Front".
  The real trigger on the original desktop is still unconfirmed; a `lost always-on-top` log line
  names the window and the moment.

## Overlay companion: open ideas (not built)

- Electron's dev-only "Insecure Content-Security-Policy" warning is now logged once per view
  at debug level instead of on every load. The real fix, a `script-src 'self'` meta tag on
  each renderer page, removed the warning and broke no page, but made 3 of 6 smoke runs hang
  on exit (0 of 6 without it). Find why before trying again.
- Log lines print contexts as `[Object: null prototype] {…}`; plain JSON would read better.
- Optionally render the PTY a few rows taller while the idle prompt box is hidden, so Claude
  keeps the same usable height.
- A tray or hotkey toggle to show Claude's prompt box again when it is wanted.

## Running it day to day

Mascot mode is the default for new profiles;
`npm run start:windows-shell:user` also forces it for existing profiles. Dashboard/tools and HUDs
are created on demand and released when closed/unused. Session details and approvals are available
from the tray or Ctrl+Shift+O. Idle/hidden states release video decoding;
history and asset cache growth are bounded.
Quit from the tray releases pending requests without granting or denying them.

Tests use an isolated Electron profile as well as temporary CCF data. The smoke run uses the
rightmost display. Live terminal activation, long-session resource behavior and a packaged
installation remain separate checks; the isolated run does not change live Claude settings.

Generated PowerShell 5.1 hooks have been exercised against the real core; coverage of real
Claude sessions is still partial.

## Debugging

Dashboard → Settings → Debug & Performance has independent debug/profiling switches, off by default.
They apply immediately and persist. See [diagnostic collection](DEBUGGING.md) for log paths,
retention, interpretation and limitations. No extra profiler process runs.

## Subsequent step: validate a packaged build

The main-process extraction is complete: `main.js` is a thin bootstrap and the shell subscribes to
core `change` events instead of replacing controller methods. Approval requests keep their waiter
handles through the shell. A disconnected duplicate loses only its waiter; the last disconnect
removes the approval without answering it and refreshes the UI.

The next unverified boundary is packaging: build the Electron app, stage and sign an MSIX, then
validate protocol activation, startup and uninstall against an installed build. Start with
[`packaging/windows/README.md`](../packaging/windows/README.md).

## Rough edges by area

- Dashboard and overlay: functional; layout density, iconography and long plan review still rough.
- Terminal focus: coarse window activation via PowerShell + `SetForegroundWindow`. Exact tab focus in
  VS Code / Cursor needs the helper extension in `extensions/vscode` (`wolframs.ccf-terminal-focus`),
  which has to be packed with `vsce` and sideloaded; nothing installs it today. See its
  [installation notes](../extensions/vscode/README.md). The sender now resolves the persistent shell above Claude instead of its own PID.
  Window activation prefers that shell's ancestor window, then a project/title match. Exact tab
  activation remains unconfirmed; helper installation alone is not proof of success.
- Hooks: PowerShell sender only. CMD, Git Bash and WSL launches of Claude are untested.
- Hotkeys are `Ctrl+...` combinations; the macOS double-tap gestures were dropped on purpose.

## Packaging (untested)

Scripts exist for an MSIX loop (`npm run packaging:windows:*`) with identity `wolframs.ChaosCatFamiliar`
and a dev publisher `CN=CCF-DEV`. Never run end to end since the rename. Open questions:
protocol activation and startup-at-login in the installed build, notification attribution, whether
uninstall keeps mascots and settings, signing. Dev-run quirk: `ccf://` may register against the
dev Electron path, so remove `HKCU\Software\Classes\ccf` by hand if it misbehaves.

## What it writes on your machine

- `%APPDATA%\chaos-cat-familiar\` settings, state, mascots, mascot video cache
- `%USERPROFILE%\.chaos-cat-familiar\hooks\hook-sender.ps1`
- hook entries in `%USERPROFILE%\.claude\settings.json`, written on every start if missing or
  drifted (removal touches only entries that point at the sender above). Test runs: see AGENTS.md.
- `HKCU\Software\Classes\ccf` and, if enabled, a login item

Before cleanup, disable launch at login in Settings and quit CCF. Then run
`./scripts/windows/dev-uninstall.ps1 -RemoveClaudeHooks -RemoveAppData -RemoveProtocolRegistration`
from the repo root. It removes the hooks, data and protocol key above; it does not remove the login
item or the sideloaded editor helper. It honors the same home/app-data overrides as the app and
leaves other Electron apps running. Hook-cleanup failure stops data removal.

## Upstream dependencies that may vanish

- Mascots other than Chaos Cat are upstream art (MIT-covered in the v0.12.0 snapshot this started
  from) and stream their videos from `assets.masko.ai`. Installing a
  mascot by slug fetches `https://masko.ai/api/mascot-templates/<slug>`. Upstream went closed source,
  so both may disappear; mascots then show no animation.
- `ccf://` replaces `masko://`; the masko.ai "install mascot" web handoff no longer reaches this app.

## Art plan

The default mascot now uses the v0.3 black-cat concept from
`assets/concepts/2026-10-19-cat/state-set/`. Its rendered local clips are in
`apps/windows-shell/assets/mascots/chaos-cat/`; regenerate them with
`node scripts/windows/render-chaos-cat-mascot.mjs` on a machine with Pillow, NumPy, and ffmpeg.
Other brand assets still need attention:

- `apps/windows-shell/assets/ccf-logo.svg` is a plain placeholder.
- `packaging/windows/assets/pixel-art/` is a generated placeholder sprite, the MSIX tiles derive from it.
- The `--ccf-*` brand tokens in `renderer/brand-tokens.css` still carry Masko's palette (orange
  `#f95d02`), restyle them with the art.
- Fonts (Fredoka, Rubik, in `assets/fonts/`) are Google Fonts under the SIL Open Font License. Each
  family's licence text sits beside its files (`OFL-Fredoka.txt`, `OFL-Rubik.txt`).

Startup does not gate the overlay on full OS discovery, and animation prefers WebM for Windows
alpha playback.
