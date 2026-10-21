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

## What is recorded

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
performs no stack/heap dumps and does no filesystem scanning. Debug logging uses bounded
synchronous appends; directory/size metadata is cached to limit filesystem overhead. Logging or
profiling failures are isolated from approval handling.

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
