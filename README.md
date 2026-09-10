# t3ctl

Local CLI for controlling an **already-running** T3 Code app. Never starts a server.
TypeScript, Node ≥22, two runtime deps (`commander`, `ws`). Token in macOS Keychain,
config in `~/.config/t3ctl/config.json`.

Status: **read-only prototype** (v0.0.1). Verified against T3 Code 0.0.38 on 2026-09-06.

```
t3ctl env                         # which server we target (no auth)
t3ctl auth pair [--operate]       # mint pairing token via installed `t3`, exchange for 30d bearer, store in Keychain
t3ctl auth status | forget
t3ctl projects [list|show <ref>]
t3ctl threads [list] [-p project] [-s status] [-a] [-n N]
t3ctl threads show <ref> [-t turns]
t3ctl threads search <query>      # WS unary RPC
t3ctl threads watch <ref> [--until-idle] [--timeout s]   # WS stream, NDJSON
```

Global: `--origin <url>`, `-f json|table`. Output is JSON automatically when stdout is not a TTY
or `T3CTL_AGENT=1`. `T3CTL_TOKEN` overrides the Keychain. `<ref>` = id, id prefix, or exact title.

Dev: `npx tsx src/index.ts …` (or `npm run build` → `dist/index.js`). Node is pinned via
`.node-version`; on this machine mise shims need `PATH=$HOME/.local/share/mise/installs/node/22.23.2/bin:$PATH`.

---

## Research summary (how T3 Code can be controlled)

Source: github.com/pingdotgg/t3code tag `v0.0.38`. Full notes in `docs/research/`.

### Transports available

| Transport | What it gives | Verdict |
|---|---|---|
| **HTTP API** (`/api/orchestration/*`, `/api/auth/*`, `/oauth/token`) | shell snapshot (projects + threads, no messages), full snapshot, thread detail with paginated messages, `POST /dispatch` for every write command | **Primary.** Enough for list/read/create/send. Stateless, trivial to call. |
| **WebSocket Effect-RPC** (`GET /ws`, JSON frames) | everything HTTP has + streaming subscriptions (`subscribeShell`, `subscribeThread`), `searchThreads`, diffs, terminals, server config | **Needed only for live streams / wait-until-idle / search.** Small hand-rolled client (`src/ws.ts`, ~120 lines) is sufficient; no need to depend on `effect`. |
| Direct SQLite (`~/.t3/userdata/state.sqlite`) | read projections, mint sessions | Rejected. Brittle across releases, bypasses the server's auth model. Only used indirectly via the official `t3 auth pairing create`. |
| MCP `/mcp` | preview-browser tools only | Not useful for thread/project control. |
| Existing `t3` CLI (`t3 project add/remove/rename`, `t3 auth …`) | project CRUD, token minting | No thread/message commands. We reuse `t3 auth pairing create` for pairing. |

So: **WS is not "the" way; HTTP is, with WS for streams.** Both are served by the same process and
share auth.

### Two servers on this machine

- `:3773` — desktop-embedded backend (Electron spawns `t3 --mode desktop --bootstrap-fd 3`). Bound to
  `0.0.0.0` because `desktop-settings.json` has `serverExposureMode: network-accessible`.
- `:58881` — background service `t3 serve` (launchd), port chosen by `findAvailablePort(3773)`.
  Owns the `cloudflared` T3 Connect tunnel for mobile/web relay.

Both use the same `~/.t3/userdata` (SQLite, signing key), so lists are identical and one token works
on both. Agent turns run inside whichever process received the dispatch. **t3ctl targets `:3773`**
so CLI-started work streams live in the desktop window. `server-runtime.json` (used by third-party
CLIs for discovery) does not exist on this install; discovery falls back to probing 3773 +
`GET /.well-known/t3/environment`.

### Auth

- Every request and WS upgrade needs a credential; `network-accessible` changes bind host only.
  No loopback bypass.
- Sessions are scoped bearer tokens (30 d): `orchestration:read`, `orchestration:operate`,
  `terminal:operate`, `review:write`, `relay:read`, plus admin `access:*`, `relay:write`.
- Pairing flow (what `t3 pair` / the mobile app do, and what `t3ctl auth pair` does):
  1. `t3 auth pairing create --json --ttl 2m` (installed runtime bin at
     `~/.t3/runtime/versions/<v>/node_modules/t3/dist/bin.mjs`) → one-time credential, written into
     the app's own DB by the official CLI.
  2. `POST /oauth/token` RFC 8693 token exchange, requesting **only `orchestration:read`** by default.
  3. Store bearer in Keychain (`security add-generic-password -s t3ctl -a <environmentId>`).
- Node `ws` can send `Authorization: Bearer` on the upgrade, so the browser-only `wsTicket`
  dance is unnecessary.
- Sessions appear in T3 Code → Connections and can be revoked there.

### Write surface (for the next phase; needs `--operate`)

All writes are `POST /api/orchestration/dispatch` with a `ClientOrchestrationCommand`
(client generates `commandId`, `threadId`, `messageId` UUIDs + `createdAt`):

- `project.create`, `project.meta.update`, `project.delete`
- `thread.create`, `thread.turn.start` (send message; `bootstrap.createThread` + `prepareWorktree`
  create-and-send atomically), `thread.turn.interrupt`, `thread.approval.respond`,
  `thread.user-input.respond`, `thread.archive/unarchive/delete/settle/snooze/pin/meta.update`,
  `thread.runtime-mode.set`, `thread.interaction-mode.set`, `thread.session.stop`.

Response is `{sequence}`; confirm by `subscribeThread({afterSequence})` or polling
`GET /api/orchestration/threads/:id`. "Idle" is derived, not an RPC: `session.activeTurnId == null`
and `latestTurn.state ∈ {completed, interrupted, error}`; `hasPendingApprovals` /
`hasPendingUserInput` mean the thread needs a human.

### Reference CLIs (studied, not used)

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

### Caveats

- Protocol is internal and unversioned; check `serverVersion` from `/.well-known/t3/environment`
  after T3 Code updates. Types in `src/http.ts` are intentionally loose.
- `t3 auth pairing create` uses Node's experimental SQLite; it prints a warning on stderr (suppressed).
- Keychain access via `security` may prompt once per new terminal binary.

## Roadmap

1. `threads new --project <ref> [--branch] [--worktree] <prompt>` and `threads send <ref> <prompt>` via `thread.turn.start` (requires `auth pair --operate`).
2. `threads wait <ref>` (reuse `watch --until-idle` logic) and `threads approve/respond`.
3. `threads archive`, `projects add`.
4. Obsidian bridge: skill instructs the management-session agent to write `t3 thread id` + status back into the task note.
5. Publish to personal GitHub (private).
