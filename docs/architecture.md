# How T3 Code is controlled

What the upstream source (github.com/pingdotgg/t3code, tag `v0.0.38`) exposes and which parts t3ctl uses.
Deeper notes: [research/](research/).

## Transports available

| Transport | What it gives | Verdict |
|---|---|---|
| **HTTP API** (`/api/orchestration/*`, `/api/auth/*`, `/oauth/token`) | shell snapshot (projects + threads, no messages), full snapshot, thread detail with paginated messages, `POST /dispatch` for every write command | **Primary.** Enough for list/read/create/send. Stateless, trivial to call. |
| **WebSocket Effect-RPC** (`GET /ws`, JSON frames) | everything HTTP has + streaming subscriptions (`subscribeShell`, `subscribeThread`), `searchThreads`, diffs, terminals, server config | **Needed only for live streams / wait-until-idle / search.** Small hand-rolled client (`src/ws.ts`, ~120 lines) is sufficient; no need to depend on `effect`. |
| Direct SQLite (`~/.t3/userdata/state.sqlite`) | read projections, mint sessions | Rejected. Brittle across releases, bypasses the server's auth model. Only used indirectly via the official `t3 auth pairing create`. |
| MCP `/mcp` | preview-browser tools only | Not useful for thread/project control. |
| Existing `t3` CLI (`t3 project add/remove/rename`, `t3 auth …`) | project CRUD, token minting | No thread/message commands. We reuse `t3 auth pairing create` for pairing. |

So: **WS is not "the" way; HTTP is, with WS for streams.** Both are served by the same process and
share auth.

## Two servers on this machine, and which one t3ctl must use

- **Desktop backend**: spawned by the Electron app on every launch (`t3 --mode desktop --bootstrap-fd 3`), dies with
  the app. Advertises `serverSelfUpdate: desktop-managed`. The UI's WebSocket is connected to this one.
- **Background service**: `t3 service install` registers a launchd agent that runs `t3 serve` at login. It hosts the
  cloudflared T3 Connect tunnel for mobile/web. Advertises `serverSelfUpdate: boot-service`.

Both bind the first free port from 3773 upward, so which one owns 3773 depends on start order after a reboot.
They share `~/.t3/userdata` (SQLite, signing key, sessions) but **not** an in-memory event bus: a command dispatched
to one process is on disk instantly, yet the other process's live subscribers never hear about it. The desktop UI is
a pure live-stream client, so dispatching to the service leaves the UI stale until it re-snapshots.

**Discovery therefore probes 3773-3780 (plus `config.origin` and `server-runtime.json`) in parallel and prefers the
`desktop-managed` server.** The service is only a fallback (with a stderr warning). `--origin` / `T3CTL_ORIGIN` bypass
discovery. `t3ctl servers` shows what is running. Tokens work on either process since they share the DB.

## Write surface

All writes are a `ClientOrchestrationCommand` sent through the WebSocket RPC
`orchestration.dispatchCommand`. **Not** `POST /api/orchestration/dispatch`: only the WS handler implements
the `thread.turn.start` bootstrap (create thread, prepare worktree, run setup script); the HTTP route hands
bootstrap to the engine and fails with `orchestration_dispatch_failed`. Commands
(client generates `commandId`, `threadId`, `messageId` UUIDs + `createdAt`):

- `project.create`, `project.meta.update`, `project.delete`
- `thread.create`, `thread.turn.start` (send message; `bootstrap.createThread` + `prepareWorktree`
  create-and-send atomically), `thread.turn.interrupt`, `thread.approval.respond`,
  `thread.user-input.respond`, `thread.archive/unarchive/delete/settle/snooze/pin/meta.update`,
  `thread.runtime-mode.set`, `thread.interaction-mode.set`, `thread.session.stop`.

Response is `{sequence}`. "Idle" is derived, not an RPC. `threads wait` subscribes to the thread stream and
treats `thread.session-set` with `activeTurnId: null` (after having seen a turn) as the end of the turn; event
payloads live under `event.payload`. `hasPendingApprovals` / `hasPendingUserInput` are shell-row flags, not
thread-stream events, so `wait` polls the shell snapshot every 5 s on the side. Archived threads are not in
the live shell snapshot; `orchestration.getArchivedShellSnapshot` returns them, and their detail endpoint 404s.

## Pending approvals

Not a first-class field. Like the web client (`apps/web/src/session-logic.ts`), t3ctl derives them from
`thread.activities`: an `approval.requested` / `user-input.requested` activity whose `payload.requestId` has no
later `*.resolved` activity is open. `threads wait` reports `needs-human` from the shell flags
`hasPendingApprovals` / `hasPendingUserInput` (polled), then `threads pending` lists the request ids.

## Caveats

- Protocol is internal and unversioned; check `serverVersion` from `/.well-known/t3/environment`
  after T3 Code updates. Types in `src/http.ts` are intentionally loose.
- `t3 auth pairing create` uses Node's experimental SQLite; it prints a warning on stderr (suppressed).
- Keychain access via `security` may prompt once per new terminal binary.

## Reference CLIs (studied, not used)

- **tarik02-org/t3code-cli** — broadest; Effect v4 + vendored upstream contracts; pairing or direct
  SQLite session mint; encrypted config + OS keyring; agent-first `--format auto`, ndjson streams,
  `wait`, `ask`, `callback`, self-action guard, ships a SKILL.md. Cost: tracks a fast-moving upstream.
- **MajesteitBart/t3code-cli** — HTTP only; shells out to `t3 auth session issue --ttl 2m` per run and
  revokes after; one `handover` workflow. Nice: `doctor`, version-gated defaults.
- **@shivamhwp/t3code-sdk** — HTTP + WS hybrid; best reconnect/resume-from-sequence logic; README says
  "do not use".

Borrowed: HTTP-first + WS-for-streams split, agent-aware output default, read-only scope by default,
derived idle heuristic, SKILL.md. Avoided: `effect` dependency, direct DB writes, vendoring contracts
(we type only what we render).
