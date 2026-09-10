# Working in t3ctl

`t3ctl` is a TypeScript CLI that controls the **already-running** T3 Code desktop app on this Mac. It must never
start a T3 server. README.md holds the user docs and protocol research; this file is for agents changing the code.

## Ground rules

- **Build after every source change: `pnpm build`.** The command is installed with `pnpm link --global`, so
  `dist/` is what every user and agent on this machine runs. Unbuilt changes are invisible. `pnpm typecheck`
  alone is not enough.
- **Never touch T3's SQLite or secrets.** Auth goes through the official `t3 auth pairing create` + `/oauth/token`.
- **Writes go over the WebSocket RPC** (`orchestration.dispatchCommand`), not `POST /api/orchestration/dispatch`.
  Only the WS handler implements the `thread.turn.start` bootstrap. Reads may use HTTP.
- **Type only what you render.** `@t3tools/contracts` is unpublished and changes per release; keep interfaces in
  `src/http.ts` loose and pass unknown fields through. Check `/tmp/t3code-src` (tag matching the installed
  `serverVersion`) or clone `pingdotgg/t3code` when you need a schema. Event payloads live under `event.payload`.
- **Read-only scope by default.** Commands that mutate must call `connect(g, { write: true })` so the session
  upgrades to `orchestration:operate` automatically.
- **Dispatch to the desktop backend**, never to the background service: two servers share the SQLite but not the
  event bus, so the UI only sees live updates from its own process. `discoverServer` prefers `serverSelfUpdate:
  desktop-managed`; do not persist or hardcode ports. `t3ctl servers` shows both.
- Node ≥22, pnpm via corepack. If `pnpm` is not found, use
  `PATH=$HOME/.local/share/mise/installs/node/22.23.2/bin:$PATH`.

## Layout

```
src/index.ts        commander program, global flags
src/commands/*.ts   one file per top-level command group (env, auth, models, projects, threads)
src/discover.ts     find the server (config → server-runtime.json → probe :3773) via /.well-known/t3/environment
src/auth.ts         pairing, token exchange, auto re-pair (ensureToken)
src/keychain.ts     macOS `security` wrapper
src/http.ts         fetch client, read endpoints, dispatch()
src/ws.ts           minimal Effect-RPC-over-WebSocket client (Request/Chunk/Ack/Exit frames)
src/models.ts       provider catalog, alias + fuzzy model resolution, option validation
src/wait.ts         wait-for-idle from the thread stream + shell polling
src/pending.ts      derive open approval / user-input requests from activities
src/time.ts         "when" parser for snooze
skills/t3ctl        agent skill; symlinked at ~/.claude/skills/t3ctl (edits are live immediately)
docs/research       protocol notes from the upstream source
```

## Adding a command

1. Find the `ClientOrchestrationCommand` variant or RPC in the contracts; note required fields (`commandId`,
   `createdAt` where present are client-generated; use `uuid()` / `nowIso()` from `src/ids.ts`).
2. Register it in the matching `src/commands/*.ts`. Accept `<ref>` = id, id prefix, or exact title via
   `matchThread` / `matchProject`. Emit with `emit(format, jsonValue, () => tableString)` so `-f json` and
   non-TTY output stay machine-readable.
3. Update README command block, `skills/t3ctl/SKILL.md` if agents should use it, and bump `version` in
   package.json for user-visible changes.
4. `pnpm typecheck && pnpm build`, then validate live (below).

## Validating live

There is no mock server; validate against the real app. Cheap, safe pattern used so far:

```sh
export T3CTL_AGENT=1                      # JSON output
t3ctl env && t3ctl auth status            # server reachable, token valid
t3ctl threads -n 3                        # reads
# writes: use the `dev` project (non-git → local env), cheapest model, trivial prompt
id=$(t3ctl threads new -p dev -m sonnet -e low -t "t3ctl e2e <feature>" "Reply with exactly OK." | jq -r .threadId)
t3ctl threads wait "$id" --timeout 120
t3ctl threads archive "$id"               # always clean up smoke threads
```

Approval paths: create with `--runtime-mode approval-required` and a prompt that writes a file under `/tmp`;
`threads pending` → `threads approve`. Snooze paths: `--draft --snooze 2h` then `unsnooze`. Never test writes
against real work threads; never archive or interrupt a thread you did not create.

Server-side failures surface as `EnvironmentInternalError`/`orchestration_dispatch_failed`; trace ids can be
grepped in `~/.t3/userdata/logs/desktop.trace.ndjson`.

## Releasing a change

`pnpm build` → live test → `git commit` → `git push` (remote `samzilverberg/t3ctl`, branch `main`). No CI yet.
