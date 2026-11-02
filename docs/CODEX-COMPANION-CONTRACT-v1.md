# Companion backend contract v1

Revised 2026-10-29 after independent review. Ordinary launch uses inherited Codex
configuration. Temporary workday test restrictions are not product policy.

## Identity and transport

Backend is `claude` (default) or `codex`. Codex conversation identity is `thread.id`;
session-root metadata does not merge forks. Core session keys include the backend.
Private app-server JSONL uses readline, JSON parsing and request-ID correlation.
There are no native supervisors, compiler bootstraps or production resource ceilings.
Stop waits for an in-progress launch and stops the owned child tree.

Adapters emit change and expose snapshot, explicit start, submit, interrupt, stop,
resolveRequest and history. Each new connection invalidates old approval keys.
Command/file approvals allow one request; permission grants are requested subsets for
the turn. Typed questions require explicit answers. Unsupported requests never grant.
Thread start and resume set `approvalPolicy:on-request` and `approvalsReviewer:user`.
The sandbox and everything else come from the user's Codex configuration.

## Delivery

Codex submission outcomes are pending, accepted, rejected or outcomeUnknown. Acceptance
requires the matched turn/start response with turn ID. Unknown input is not auto-retried.
Only acceptance clears the matching draft revision and attachment IDs.
Claude's boundary remains PTY-write completion, with no hook-ID prerequisite.

One atomic app-data JSON file retains conversation IDs, outcomes and optional watcher
inbox state. Electron's single-instance lock provides process ownership; no PID lock or
append-only outcome archive exists. Old terminal outcomes expire after seven days;
pending and unknown entries remain. Corrupt/newer data is reported, never silently reset.

Watcher wire v1 is newline JSON with `schemaVersion:1`, `type:companion-event`, and an
event containing id, source, key, revision, severity, generation, occurredAt, expiresAt
and payload. Receipt `{schemaVersion:1,type:receipt,id}` follows inbox storage only.
Source IDs deduplicate. Expired facts cannot be sent. Only explicit replaceable tell
facts coalesce; urgent and in-flight facts remain distinct. Idle wake batches contain
at most ten events. Model rejection pauses the batch; uncertainty blocks replay.

## Habitat and UI

The Python bridge owns daily memory transactions. CCF claims before Codex startup,
binds the actual thread ID, and checkpoints prepared memory after matched acceptance.
No-op memory preparation creates no acknowledgement transaction. Stop is resumable;
end-day closes ownership. Source/data roots are separate and selection copies no memory.

Claude uses its existing PTY view. Codex renders literal structured text and approval
cards; tool previews are bounded for presentation. Live history is separate from explicit
saved-history browsing. Authoritative history pages follow server-provided cursors.
Idle backend switching never auto-starts the target or transfers a shared daily owner.
The composer draft belongs to the pane: hook identity changes and backend switches never clear it.

Ordinary Codex hooks send `integration_source:codex-hook` and `observation_only:true`
to the authenticated observation endpoint. Native `source` values such as startup/fork
remain separate. Observations never enter CCF's approval-decision queue.

See [operations](CODEX-COMPANION-OPERATIONS.md) for setup and current validation boundaries.
