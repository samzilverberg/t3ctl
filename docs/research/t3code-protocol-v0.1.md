# T3 Code 0.1.x (orchestrator V2) — what changed for t3ctl

Recorded 2026-10-22 against the installed desktop app 0.1.1 (`/Applications/T3 Code (Beta).app`) and the
upstream tag `v0.1.1`. The earlier notes in `t3code-protocol-v0.0.38.md` describe the V1 alphas and are kept
for history only.

## Versioning signals

- `GET /.well-known/t3/environment` → `serverVersion: "0.1.1"`, **`orchestrationProtocolVersion: 2`** (new field;
  `packages/contracts/src/environment.ts`: `ORCHESTRATION_PROTOCOL_VERSION = 2`).
- HTTP: `/api/orchestration/*` endpoints declare `OrchestrationProtocolHeaders` → request header
  `x-t3-orchestration-protocol: 2` is required (400 without it).
- WS: `/ws?orchestrationProtocol=2` required (426 `{"code":"orchestration_protocol_incompatible"}` without it).
- Release notes v0.1.0: "A V2 server and a V1 app can't talk to each other." The first V2 start copies the V1
  database (`state.sqlite` → `statev2.sqlite`) and imports threads one-way.

## HTTP routes (contracts `environmentHttp.ts`)

Gone: `GET /api/orchestration/snapshot`, `POST /api/orchestration/dispatch`.
Present: `/api/orchestration/shell` (→ `{schemaVersion, snapshotSequence, threads, archivedThreads, projects}`;
`archivedThreads` is empty in practice, use the RPC), `/api/orchestration/threads/:threadId` (→
`{snapshotSequence, projection}`; `turnLimit` is ignored), `…/bounded`, `…/history`, `…/transcript`,
`/api/projects`, `POST /api/projects/mutate` (`ProjectMutation`), `/api/auth/session`, `/oauth/token`, pairing
and T3 Connect routes, `POST|PUT|GET /webhooks/…` for scheduled tasks.

## RPC (`ORCHESTRATION_V2_WS_METHODS`, `WS_METHODS`)

`orchestration.dispatchCommand`, `getTurnDiff`, `getFullThreadDiff`, `searchThreads`, `searchThread`,
`searchThreadStream`, `getArchivedShellSnapshot`, `getThreadProjection`, `getWorkflowScript`, `stopWorkflow`,
`getTurnItem`, `launchThread`, `subscribeArchivedShell`, `subscribeShell`, `subscribeThread`,
`subscribeCommandOutput`; `server.getConfig` (still `{providers, settings, …}`); `scheduledTasks.list |
subscribe | upsert | setEnabled | delete | runNow | rotateWebhookToken | listWebhookDeliveries |
getWebhookDelivery` (read scope for list/subscribe, operate for the rest).

## Command union (`OrchestrationV2Command`)

Removed from V1: `thread.turn.start` (+ bootstrap), `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `project.*` on the command bus.
Replacements: `orchestration.launchThread` (create + workspace + first run), `message.dispatch` (with
`dispatchMode`), `thread.stop` / `run.interrupt`, `runtime-request.respond {requestId, decision?, answers?}`,
`POST /api/projects/mutate`. Still there with the same shape: `thread.create` (now needs `createdBy`,
`creationSource`), `thread.archive/unarchive/delete/settle/unsettle/snooze/unsnooze/pin/…`,
`thread.runtime-mode.set`, `thread.interaction-mode.set`, `thread.model-selection.set`. New: `thread.fork`,
`thread.merge_back`, `delegated_task.*`, `queued-run.*`, `checkpoint.*`, `provider.switch`.

## Thread model

V1 shell fields `session`, `latestTurn`, `hasPendingApprovals`, `hasPendingUserInput`, `activities` are gone.
V2: `status` (`idle` | run status), `activeRunId`, `latestRunId`, `pendingRuntimeRequest`, `lastError`,
`latestVisibleMessage`, `createdBy`, `creationSource`, `lineage`, `pullRequests`, …; projection has `runs`,
`attempts`, `nodes`, `runtimeRequests`, `messages`, `turnItems`, `plans`, `checkpoints`, `subagents`, …
Thread stream items: `synchronized`, `snapshot {projection}`, `event {sequence, event: {type, payload}}` with
event types `thread.created`, `thread.<verb>ed`, `run.created|updated` (payload `Run`), `run-attempt.*`,
`node.updated`, `runtime-request.updated` (payload `RuntimeRequest`), `message.updated` (payload
`ConversationMessage`), `turn-item.updated`, `provider-*`, `subagent.updated`.

## Built-in scheduler

`apps/server/src/scheduledTasks/ScheduledTaskService.ts`; table `scheduled_tasks` (migration 055
`OrchestrationV2/ScheduledTasks.ts`, webhooks in 057/058/067). Schedules: `interval {everyMs ≥ 60000}`,
`fixed_time {timeOfDay "HH:MM", weekdays?}` (server-local time), `webhook`. Each task is project-bound and
optionally thread-bound; a run either `launchThread`s (new thread, stored `workspaceStrategy`, `modelSelection`,
modes, `createdBy`, `creationSource`) or `sendToThread` with `mode: "queue"`. Overlap: an occurrence is skipped
while the task's previous run is still active. Poll loop every 5 s (`scheduling/Scheduler.ts`); due work waits
for startup recovery. The desktop MCP `schedule_task` tool maps onto `scheduledTasks.upsert` with
`createdBy: "agent"`, `creationSource: "mcp"`, workspace `{type:"root"}` when thread-bound else
`{type:"worktree", baseRef:"main", startFromOrigin:true}`.

## Pairing

`~/.t3/bin/t3` is a wrapper written by the desktop app that runs the CLI bundled in the app bundle
(`t3 --version` → `t3 v0.1.1`); `t3 auth pairing create --json --ttl 2m --label …` is unchanged. The
`~/.t3/runtime/versions/<v>` tree now only holds background-service versions (0.0.x here) and must not be
preferred.
