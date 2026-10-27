# Debugging

Open Dashboard → Settings → Debug & Performance. Enable **Debug logging** and **Light
performance profiling** before reproducing a problem. Both switches apply immediately, persist
across restarts, and default to off. Errors and normal lifecycle messages are always logged.

The panel shows the actual log path and any write/sampling error; Refresh diagnostic status
updates these without background polling. Default path:

`%APPDATA%\chaos-cat-familiar\logs\chaos-cat-familiar.log`

Keep this file and its `.1` sibling when investigating. Rotation keeps two files of up to 2 MiB
each; older entries are discarded. No upload happens. Note the approximate time, action, project
and what you expected alongside the logs. Avoid Clear Mascot/Cache/Logs until evidence is collected.
There is no need to copy the full state/settings files (which can contain tool data or credentials).

Fatal main-process JavaScript errors show a dialog with the log path before shutdown;
test mode suppresses dialogs. Native process termination can bypass this handler.
Mascot dragging keeps its latest position in memory and saves on release, cancellation,
capture loss, renderer reload/loss or orderly shutdown. Preferences are read once when
dragging begins. Each final save rereads settings to preserve unrelated external edits.

Temporary placement-save failures (`EPERM`, `EACCES`, `EBUSY`) retry after 250 ms, 1 s
and 3 s. Pending movement replaces one queued position; it does not add disk traffic.
Repeated errors are deduplicated. After the bounded retries, later movement or shutdown
can retry. A permanently unwritable file leaves the last saved position on disk.
Diagnostic metadata exposes `placement` pending/error status.

## What is recorded

- Tray action failures are logged under `tray` and show an error dialog. A failed
  menu action is caught before it can become a fatal process exception. Hook setup
  lives in Dashboard → Settings, where its result can be inspected.
- Normal lifecycle, hook installation, approvals, window/renderer failures and activation attempts.
- Debug: request ID, hook/session/tool identity, HTTP status, disconnects and elapsed milliseconds.
  No request body or headers are added by tracing. Sensitive structured context keys are redacted
  recursively, and retained context/message size is bounded. Arbitrary free-text messages are not
  guaranteed free of private data; review logs before sharing outside this machine.
- Profiling: an immediate baseline, then one sample every 30 seconds. Electron process PID/type,
  private memory and working set (KiB), main-process heap/RSS (bytes), window/session/approval
  counts, CPU delta and timer scheduling lag. Last 20 samples remain in memory; samples also
  go to the rotated log independently of debug logging.

CPU is a percentage of **one logical core**, summed over processes that have consecutive samples.
The baseline/new processes have no delta yet. Short-lived processes between samples are missed.
Summed working sets include shared pages. Scheduling lag is a coarse main-process delay indicator,
not a stack profiler; machine sleep and system load can increase it. Permission request durations
include time waiting for the person to answer, so a long duration alone is not a performance fault.

Turning profiling off or quitting removes its timer and CPU baseline. It launches no subprocesses,
performs no stack/heap dumps and does no filesystem scanning. File logs batch for up to 250 ms,
subject to main-loop scheduling, with a 64 KiB pending buffer cap. Warnings/errors flush immediately;
in-memory entries and console output remain immediate. Rotation still keeps two 2 MiB files.
Directory/size metadata is cached. Disk failures keep a bounded buffer, expose dropped-line counts
and do not start an idle retry loop. Logging/profiling failures remain isolated from approvals.

## State checkpoints and unclean shutdowns

Hook state is immediately visible in memory. Disk checkpoints coalesce over 250 ms,
serializing the latest pending state through same-directory atomic replacement.
Explicit settings changes still save immediately. Failed checkpoints retain the latest
state in memory and the last valid disk checkpoint; later activity or shutdown can retry.
Batched store `load()` reads the disk checkpoint rather than pending memory changes.

`%APPDATA%\chaos-cat-familiar\run-marker.json` is written once at startup and removed
only after orderly shutdown has flushed state, logs and pending placement. It uses no
periodic heartbeat. A leftover marker produces a warning on the next launch; CCF loads
the last valid checkpoint. Fatal errors, failed startup and failed final writes retain
the marker. Malformed JSON uses the existing quarantine/recovery-note mechanism.
Pending approvals are not replayed or automatically answered after a restart.

An abrupt kill or power loss can lose the latest buffered history/logs; scheduling stalls
can extend the nominal 250 ms window. The marker cannot reconstruct unwritten data.
Diagnostic metadata includes `persistence` and `recovery`, alongside buffered bytes,
dropped log lines and placement status. Local-data cleanup removes the marker/checkpoint.

## Isolated verification

`npm run smoke:windows-shell` retains its default short run. To exercise enabled diagnostics:

```powershell
$env:CCF_SMOKE_DIAGNOSTICS = '1'
$env:CCF_SMOKE_SAMPLE_MS = '31000'
npm run smoke:windows-shell
Remove-Item Env:CCF_SMOKE_DIAGNOSTICS, Env:CCF_SMOKE_SAMPLE_MS
```

The harness seeds only temporary settings, verifies periodic samples and debug log entries,
then stops its processes and removes temporary data. It uses the rightmost display.
