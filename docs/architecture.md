# How T3 Code is controlled

What the upstream source (github.com/pingdotgg/t3code, tag `v0.1.1`) exposes and which parts t3ctl uses.
Deeper notes: [research/](research/). **Minimum T3 Code version: 0.1.0** (orchestrator V2, protocol 2); the
0.0.x alphas are refused with `incompatible_server`.

## Transports available

| Transport | What it gives | Verdict |
|---|---|---|
| **HTTP API** (`/api/orchestration/shell`, `/api/orchestration/threads/:id[/bounded|/history|/transcript]`, `/api/projects`, `/api/projects/mutate`, `/api/auth/*`, `/oauth/token`) | shell snapshot (projects + live threads), full thread projection (messages, runs, runtime requests, turn items), project CRUD | **Reads + project CRUD.** Every `/api/orchestration/*` request must carry `x-t3-orchestration-protocol: 2` (else 400). |
| **WebSocket Effect-RPC** (`GET /ws?orchestrationProtocol=2`, JSON frames) | `orchestration.dispatchCommand`, `orchestration.launchThread`, `orchestration.subscribeThread`, `orchestration.searchThreads`, `orchestration.getArchivedShellSnapshot`, `server.getConfig`, `scheduledTasks.*` | **All writes, streams, search, scheduler.** Without the query param the upgrade is refused with 426 `orchestration_protocol_incompatible`. Small hand-rolled client (`src/ws.ts`). |
| Direct SQLite (`~/.t3/userdata/statev2.sqlite`) | projections, scheduled_tasks, sessions | Rejected: brittle, bypasses auth. Only touched indirectly via the official `t3 auth pairing create`. |
| MCP (`/mcp`) | the agent toolset (threads, scheduled tasks, previews) | Needs an MCP OAuth client; same backend as the RPCs we use directly. |
| `t3` CLI (`~/.t3/bin/t3`, bundled in the app) | `t3 auth pairing create`, project commands | Used for pairing only. |

## Compatibility gate

`/.well-known/t3/environment` reports `serverVersion` and (since 0.1.0) `orchestrationProtocolVersion`. `connect()`
refuses anything below `MIN_SERVER_VERSION` (0.1.0), anything without a protocol version, and any protocol other
than `SUPPORTED_PROTOCOL` (2) with `incompatible_server`, exit 7, before the first request. `t3ctl env` reports
`supported` / `unsupportedReason` and exits 7 too; `t3ctl servers` marks unsupported servers. Constants live in
`src/discover.ts`.

## Two servers on this machine, and which one t3ctl must use

- **Desktop backend**: spawned by the Electron app, dies with it, advertises `serverSelfUpdate: desktop-managed`.
  The UI's WebSocket is connected to this one.
- **Background service** (`t3 service install`, `t3 serve` at login): hosts the T3 Connect tunnel, advertises
  `boot-service`.

Both bind the first free port from 3773 upward and share `~/.t3/userdata` but not an event bus, so a command
dispatched to the service leaves the UI stale. Discovery probes 3773-3780 (plus `config.origin` and
`server-runtime.json`) in parallel and prefers the desktop backend; the service is a fallback with a warning and
`degraded: true` in `t3ctl env`. Never fall back on a timeout: the recorded origin is retried before settling.

## Read model (orchestrator V2)

- **Shell row** (`OrchestrationV2ThreadShell`): `status` is `idle` or the active/latest run's status
  (`preparing|queued|starting|running|waiting|completed|interrupted|failed|cancelled|rolled_back`), `activeRunId`,
  `pendingRuntimeRequest {id, kind, blocking}` while a run waits on a human, `latestVisibleMessage`, plus
  `archivedAt/settledAt/snoozedUntil`. `threadStatus()` in `src/wait.ts` maps that to t3ctl's `running | idle |
  needs-approval | needs-input | error | interrupted | archived | new`. Thread ids are not always UUIDs
  (`mcp:<uuid>`, `thread:provider:…`).
- **Projection** (`GET /api/orchestration/threads/:id` → `{snapshotSequence, projection}`): `thread`, `runs`,
  `runtimeRequests` (first-class pending approvals/questions), `messages` (`role`, `text`, `runId`), `turnItems`
  (`approval_request` / `user_input_request` carry the prompt, options and questions for a `requestId`).
  `threads pending` joins `runtimeRequests[status=pending]` with those turn items.
- Archived threads are not in the HTTP shell; `orchestration.getArchivedShellSnapshot` returns them.

## Write surface

- **Create + first run**: `orchestration.launchThread {commandId, threadId?, projectId, title, modelSelection,
  runtimeMode, interactionMode, workspaceStrategy, initialMessage}`. `workspaceStrategy` is `{type:"root",
  branch?}`, `{type:"worktree", baseRef, branch?, startFromOrigin?}` or `{type:"existing_worktree", worktreePath}`;
  the server prepares the worktree and runs the setup script (no client flag). Returns `{threadId, projection}`.
- **Everything else** is an `OrchestrationV2Command` through `orchestration.dispatchCommand` → `{sequence}`:
  `thread.create` (draft), `message.dispatch {messageId, text, attachments, dispatchMode: start_immediately |
  queue_after_active | steer_active{targetRunId} | restart_active | defer_start}`, `runtime-request.respond
  {requestId, decision | answers}`, `thread.stop`, `thread.archive/unarchive/settle/unsettle/snooze/unsnooze`,
  `thread.runtime-mode.set`, `thread.interaction-mode.set`. Commands carry `createdBy: "user"`,
  `creationSource: "server"` where the schema has creation fields.
- **Projects**: `POST /api/projects/mutate` with `project.create | project.update | project.delete`.
- **Scheduler**: `scheduledTasks.list | upsert | setEnabled | delete | runNow` (`upsert` with `id` +
  `requireExisting` edits). See [scheduler.md](scheduler.md).

"Idle" is derived, not an RPC. `threads wait` subscribes to `orchestration.subscribeThread` and ends on a
terminal `run.updated` (`completed|failed|interrupted|cancelled`) after having seen an active run, or on a
pending `runtime-request.updated`; `message.updated` events supply `lastAssistantText`. The shell row is polled
every 5 s as a safety net.

## Caveats

- Types in `src/http.ts` are intentionally loose; re-check against the contracts after each T3 Code release
  (`git clone --depth 1 --branch v<serverVersion> https://github.com/pingdotgg/t3code /tmp/t3code-src`).
- `t3 auth pairing create` prints Node warnings on stderr (suppressed).
- Keychain access via `security` may prompt once per new terminal binary.

## Reference CLIs (studied, not used)

- **tarik02-org/t3code-cli**, **MajesteitBart/t3code-cli**, **@shivamhwp/t3code-sdk**: all written against the
  V1 alphas. Borrowed ideas: HTTP-first + WS-for-streams split, agent-aware output default, read-only scope by
  default, derived idle heuristic, SKILL.md. Avoided: an `effect` dependency, direct DB writes, vendoring contracts.
