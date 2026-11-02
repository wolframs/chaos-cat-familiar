# Status

As of 2026-11-02. Dev-run only: no installer, no packaged build has been tested.

## Where it stands

- Cat speech bubbles: the work companion's watcher can post `POST /companion/bubble`, and the
  cat says it in a bubble above its head. A request carries free text, or an event name with
  placeholders; CCF then picks the line from its catalog (`assets/cat-lines.json`) by rarity
  tier, with lore and night lines. Six bubble styles, a 1-in-7 special entrance (legendary lines
  always get it), and bubbles stack until each is clicked. Covered by unit, runtime and smoke tests.
- Http hooks: routine Claude events reach CCF as Claude Code http hooks, with no Git Bash +
  PowerShell process per event (a sender start cost ~2.6 s and ~0.7 CPU-s on a busy laptop).
  The sender stays for `SessionStart`, `UserPromptSubmit` and `PermissionRequest` (shell PID,
  blocking reply). `POST /hook` answers routine events before ingesting them, and `state.json`
  is checkpointed every 2 s instead of every 250 ms; stop and exit still flush.
- Codex companion: the companion pane can run `codex app-server` as a plain child with the
  user's own config, show the conversation, route approvals, and switch backends while idle.
  Codex hooks feed observation of other Codex sessions; they are installed only from Settings,
  never on start. Tested with fakes and the real hook sender/server; no live Codex run yet.
  See [operations](CODEX-COMPANION-OPERATIONS.md) and the [contract](CODEX-COMPANION-CONTRACT-v1.md).
- Open: the cat flickers now and then, trigger unknown. The overlay logs
  `Mascot state flipped and came back` (warn, category overlay-ui) with each step's inputs and
  sessions, to be removed (`noteMascotFlip` in `renderer/overlay.js`) once the cause is fixed.
- The Claude approval banner says to answer in Claude's menu with ↑ ↓ and Enter, and to clear
  the input first when it holds a draft (keys reach Claude only from an empty input).
- The developer overlay opens at its own size instead of inheriting the mascot's bounds, fits
  and scrolls inside the window, puts pending approvals first, drags by its header, and opens
  its controls panel on right-click. Dashboard Settings puts the shell-mode, opacity and scale
  controls in their rows and no longer re-renders a slider mid-drag.
- Tray panes (dashboard/settings, mascot library, preview, diagnostics) share the companion's
  dark plum/lilac palette and Rubik typography, each with a draggable titlebar and minimize,
  maximize/restore and close controls. `npm run smoke:utility-panes` checks these in an
  isolated Electron profile.
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
- Core (`packages/core`): hook server, sessions, approvals, notification routing. Covered by automated tests; real Claude-session validation remains outstanding.
- Shell (`apps/windows-shell`): tray, overlay, dashboard, diagnostics, mascots. Claude Code
  remains the default; hosted Codex is opt-in with explicit source/data/auth/model settings.
  Copilot remains excluded. Runs with `npm run start:windows-shell`.
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
- Hooks: http hooks for routine events, the PowerShell sender for the three that need a shell PID
  or a blocking reply. CMD, Git Bash and WSL launches of Claude are untested. While CCF is not
  running, each routine event shows Claude's "hook error" notice (connection refused); the tool
  call still proceeds.
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
  drifted (removal touches only entries that point at the sender above, or http hooks to
  `127.0.0.1:<port>/hook` carrying an `X-Ccf-Token` header). Test runs: see AGENTS.md.
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
- The `--ccf-*` brand tokens in `renderer/brand-tokens.css` use the companion's plum/lilac palette.
- Fonts (Fredoka, Rubik, in `assets/fonts/`) are Google Fonts under the SIL Open Font License. Each
  family's licence text sits beside its files (`OFL-Fredoka.txt`, `OFL-Rubik.txt`).

Startup does not gate the overlay on full OS discovery, and animation prefers WebM for Windows
alpha playback.
