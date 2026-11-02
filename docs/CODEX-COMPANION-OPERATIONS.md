# Hosted Codex companion

Claude remains the default and uses its existing launcher and sign-in.
Codex starts only when requested, as a private `codex app-server --listen stdio://`
child. CCF does not attach to the desktop app's conversations.

## Configuration

Codex inherits the normal user environment, home directories and Codex configuration,
including provider settings, network, MCP servers and plugins. CCF adds the selected
habitat paths and asks for on-request approvals answered in the pane; the sandbox
comes from the user's Codex configuration.
It applies no CPU, memory, process-count or PowerShell-version restriction.
Startup does not compile native helpers or inspect authentication files.

Model and Codex home are optional overrides. Without them, Codex uses its configured
model and authentication. A separate home needs its own sign-in. CCF never copies tokens.
The optional executable overrides select the actual Codex and Python executables.

Set companion source to the checkout containing `tools/companion_bridge.py` and the
shared persona. Data selects the existing habitat with memory, config, state and journal.
Source and data remain separate. The core defaults to `data/habitat/CORE.md`; an existing
core inside data can be selected explicitly. No production memory is initialized or copied.
Habitat integration requires the companion bridge implementation on `codex/ccf-companion`.

Settings changes apply on the next Start. The Claude repository setting preserves an
already-running session's hook routing. Claude requires no Codex configuration.

## Conversation and lifecycle

The idle backend picker disconnects and selects the other backend. It preserves the
saved day, keeps the composer text and staged images, and leaves startup to Start.
Active turns and outstanding requests prevent switching. A shared habitat's daily owner
must finish its day before another backend can claim it.

Disconnect stops the watcher and private process, preserving thread identity for resume.
Windows stop uses hidden `taskkill /T /F` for the owned process tree. End day closes
habitat ownership after the companion's journal/memory routine is complete.

Codex clears the draft and attachments after a matched `turn/start` acceptance.
Lost responses show **May have been sent** and are never retried automatically; after a
relaunch the uncertain text returns to an empty draft.
Conversation identity, inbox and submission outcomes use one atomic JSON file under
CCF app-data. Electron provides the single-instance lock; there is no PID writer lock.
Claude retains its PTY-write boundary and can send before hook identity arrives.

The conversation shows the retained live items (up to 500). Load older pages back from
the resume cursor (or from the newest saved page once the live window was trimmed) and
then follows each page's cursor. Jump to latest returns to live output.
Consecutive system updates share a compact box. Assistant turns are labelled CCF.
Neutral acceptance notices require startup `--debug-ui` or `CCF_DEBUG_UI=1`.

## Other Codex sessions

Install Codex observations changes only CCF-owned entries in the selected `hooks.json`.
Review/enable those handlers using Codex's hooks UI. Events use an authenticated local
observation route and backend-qualified identities. The integration marker is
`integration_source`; Codex's own `source` metadata remains separate.
Observation hooks never decide approvals; hosted requests use the private app-server RPC.

Sensors remain opt-in via `companionSensorsEnabled`. Inbox receipts acknowledge storage,
not model execution. The watcher waits for idle turns and preserves uncertain submissions.
Stop runtimes before rollback; preserve current memory, journals and unknown outcomes.

## Validation boundaries

`npm test` uses fake process transports and temporary data. It starts no real model,
changes no real hook configuration and controls no desktop. Earlier native-supervisor
and synthetic live-trial results describe the superseded implementation; they do not
validate this simplified launch. A new live run remains for an operator-controlled restart.
