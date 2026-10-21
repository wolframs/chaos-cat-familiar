<!-- DRAFT: needs author -->
# Chaos Cat Familiar

**A desktop familiar for Claude Code on Windows.**

A small black cat with violet flames sits above your windows and changes state with your Claude Code
sessions: idle, thinking, working, needs attention. When Claude asks for permission, asks a question
or wants a plan reviewed, you answer from the overlay instead of hunting for the right terminal.
A dashboard keeps sessions, approvals and notifications in one place.

Short name: **CCF**. It is dev-quality and runs from a checkout; there is no installer yet.

## Run it

Windows, Node (tested with 24):

```powershell
npm install
npm test
npm run start:windows-shell
```

`start:windows-shell` runs `electron .` in `apps/windows-shell`. New profiles start in floating-mascot mode.
Use `npm run start:windows-shell:user` to force mascot mode for an existing profile, or
`npm run start:windows-shell:developer` for the larger developer overlay.
Open the dashboard with Ctrl+Shift+O or from the tray menu; choose **Quit** in the tray menu to stop.

Floating mode reserves only three shortcuts: Ctrl+Shift+Space (overlay), Ctrl+Shift+O (dashboard)
and Ctrl+Shift+D (diagnostics). Ctrl+Tab, Ctrl+Enter and number keys stay with your other apps.

To try it without touching your real Claude profile, run the smoke test, which starts the shell
against a throwaway profile and exits:

```powershell
npm run smoke:windows-shell
```

Or point `CCF_HOME_OVERRIDE` and `CCF_APPDATA_OVERRIDE` at temp folders before
`npm run start:windows-shell`.

## How it hears Claude Code

CCF installs hooks in `~/.claude/settings.json` that call
`~/.chaos-cat-familiar/hooks/hook-sender.ps1`, which posts to a local server on `127.0.0.1`
(port `49152` by default; CCF picks a free port if that one is taken and writes it into the sender).
Each install gets its own token, and the server rejects requests without it.

- **Starting the app installs the hooks**, or repairs them, without asking.
- Permission requests wait for your answer in the overlay. Quit CCF and your sessions fall back to
  asking in the terminal.
- Repair or remove the hooks from the dashboard (Settings, Claude Code Hooks). Removal only touches
  entries that point at CCF's sender; your other hooks stay.

## Remove it

Disable launch at login in Settings and quit CCF. Then, from the repository root:

```powershell
./scripts/windows/dev-uninstall.ps1 -RemoveClaudeHooks -RemoveAppData -RemoveProtocolRegistration
```

This removes CCF's hooks, its data under `%APPDATA%\chaos-cat-familiar\` and the `ccf://` protocol
registration. It does not remove a login item or the optional editor helper.

## The companion panel

CCF can also host one Claude Code session itself: a frameless conversation panel anchored above
the cat, with a live coloured terminal, one multiline prompt, pasted or dropped images, and four
rows of status gauges beside the cat. Ctrl+numpad +/- changes the text size and the terminal
reflows to fit. The panel needs an optional companion launcher, which is not included: a
PowerShell script that starts the Claude Code session inside CCF. Its location under your home
folder is set where `CompanionSession` is created in
`apps/windows-shell/runtime/windows-shell-runtime.js`.
Without it, CCF is the cat, the overlay and the dashboard. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the panel is wired.

## Layout

- `packages/core`: hook server, sessions, approvals, notifications. No Electron.
- `apps/windows-shell`: the Electron app (tray, overlay, dashboard, mascots, companion panel).
- `extensions/vscode`: optional helper that focuses the exact terminal tab in VS Code or Cursor
  ([installation and limitations](extensions/vscode/README.md)).
- `scripts/windows`, `packaging/windows`: dev install/uninstall, asset export, an untested MSIX loop.
- `assets/concepts`: how the cat was drawn, with every image-generation prompt kept beside its output.

[`docs/STATUS.md`](docs/STATUS.md) lists the rough edges and what CCF writes on your machine.
[`AGENTS.md`](AGENTS.md) has the development commands and conventions.

## Where it came from

CCF started as a Windows port of [Masko Code](https://github.com/RousselPaul/masko-code) v0.12.0
by Paul Roussel and contributors, under the MIT licence, and has since gone its own way: the macOS
app is gone, Codex and Copilot support is cut, and the brand is replaced.

- Chaos Cat is the bundled default mascot, with local transparent animation clips.
- The other bundled mascots are Masko's art from that MIT snapshot; their videos stream from
  `assets.masko.ai` and may stop working if that service goes away.
- Fredoka and Rubik are Google Fonts under the SIL Open Font License; their licence texts are
  in `apps/windows-shell/assets/fonts/`.

[`ABOUT-THIS-REPOSITORY.md`](ABOUT-THIS-REPOSITORY.md) says how this copy relates to the working
repository.

## License

MIT, see [`LICENSE`](LICENSE). Masko's original copyright notice stays alongside the new one.
