# Working in t3ctl

`t3ctl` is a TypeScript CLI that controls the **already-running** T3 Code desktop app on this Mac. It must never
start a T3 server. README.md holds the user docs and protocol research; this file is for agents changing the code.

## Ground rules

- **Target: T3 Code ≥ 0.1.0 (orchestrator V2, protocol 2).** `MIN_SERVER_VERSION` / `SUPPORTED_PROTOCOL` in
  `src/discover.ts` gate every connect (`incompatible_server`, exit 7). Do not add compatibility branches for the
  0.0.x alphas; bump the constants (and re-check the contracts) when T3 Code bumps the protocol.
- **Build after every source change: `pnpm build`.** The command is installed with `pnpm link --global`, so
  `dist/` is what every user and agent on this machine runs. Unbuilt changes are invisible. `pnpm typecheck`
  alone is not enough.
- **Never touch T3's SQLite or secrets.** Auth goes through the official `t3 auth pairing create` + `/oauth/token`.
- **Writes go over the WebSocket RPC**: `orchestration.launchThread` creates a thread with its workspace and
  first run; everything else is an `OrchestrationV2Command` via `orchestration.dispatchCommand`
  (`message.dispatch`, `runtime-request.respond`, `thread.stop`, `thread.*`). Projects use
  `POST /api/projects/mutate`. Reads use HTTP with the `x-t3-orchestration-protocol: 2` header; the WS URL carries
  `?orchestrationProtocol=2`. Recurring schedules are the server's (`scheduledTasks.*`); the only client-side
  scheduling is `--once` (src/once.ts + the launchd ticker), because the server has no single-fire schedule.
- **Type only what you render.** `@t3tools/contracts` is unpublished and changes per release; keep interfaces in
  `src/http.ts` loose and pass unknown fields through. Check `/tmp/t3code-src` (tag matching the installed
  `serverVersion`; `git clone --depth 1 --branch v<version> https://github.com/pingdotgg/t3code /tmp/t3code-src`)
  when you need a schema: `packages/contracts/src/orchestrationV2.ts` (commands, shell, projection, events),
  `environmentHttp.ts` (HTTP routes), `rpc.ts` (WS methods), `scheduledTask.ts`. Event payloads live under
  `event.payload`.
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
src/commands/*.ts   one file per top-level command group (env, auth, models, projects, threads, schedule)
src/ops.ts          createThread / createThreads (--batch) / startTurn shared by `threads new|send` and the scheduler
src/guard.ts        duplicate + rate-limit guard for `threads new` (thresholds: config.json `guard`)
src/errors.ts       CliError: code + details, printed as {"error":…} on stdout in JSON mode, custom exit code
src/args.ts         shared commander argument parsers (intArg)
src/discover.ts     find the server (config → server-runtime.json → probe :3773) via /.well-known/t3/environment
src/auth.ts         pairing, token exchange, auto re-pair (ensureToken)
src/keychain.ts     macOS `security` wrapper
src/http.ts         fetch client, read endpoints, dispatch()
src/ws.ts           minimal Effect-RPC-over-WebSocket client (Request/Chunk/Ack/Exit frames)
src/models.ts       provider catalog, alias + fuzzy model resolution, option validation
src/wait.ts         threadStatus() from the V2 shell row; wait-for-idle from the thread stream + shell polling
src/pending.ts      pending approvals / questions from projection.runtimeRequests + request turn items
src/time.ts         "when" parser for snooze and one-shot schedules
src/schedule.ts     schedule parsing/rendering, cron → T3 schedule conversion, legacy (≤0.4) job file reader for `schedule migrate`
src/once.ts         client-side one-shot jobs (~/.config/t3ctl/once.json): store, due/grace evaluation, tick lock
src/launchd.ts      LaunchAgent dev.t3ctl.scheduler running `schedule tick` every minute (T3CTL_NO_LAUNCHD=1 disables; tests set it)
skills/t3ctl        agent skill; symlinked at ~/.claude/skills/t3ctl (edits are live immediately)
test/*.test.ts      node:test unit tests (run with `pnpm test`); test/fixtures = scrubbed V2 server payloads
docs/*.md           user docs split by topic (commands, scheduler, models, auth, agents, architecture)
docs/research       protocol notes from the upstream source
```

## Adding a command

1. Find the `OrchestrationV2Command` variant or RPC in the contracts; note required fields (`commandId`,
   `messageId`, `threadId` are client-generated: `uuid()` from `src/ids.ts`; commands with creation fields take
   `createdBy: "user"`, `creationSource: "server"`).
2. Register it in the matching `src/commands/*.ts`. Accept `<ref>` = id, id prefix, or exact title via
   `matchThread` / `matchProject`. Emit with `emit(format, jsonValue, () => tableString)` so `-f json` and
   non-TTY output stay machine-readable.
3. Update `docs/commands.md` (and the README quick tour if it is a headline feature), `skills/t3ctl/SKILL.md` if
   agents should use it, and bump `version` in package.json for user-visible changes.
4. `pnpm typecheck && pnpm build`, then validate live (below).

## Tests

`pnpm test` runs `node --test` through tsx against fixtures in `test/fixtures/` (provider catalog, a scrubbed V2
shell snapshot with one thread per derived status, a projection with a pending approval and a pending question).
Pure logic is covered: `time`, `schedule` (duration/weekday/cron conversion, legacy job conversion), `models`
(alias + fuzzy resolution, option validation), `pending`, `threadStatus`, `matchThread`/`matchProject`, the
guard and batch parsing, `compatibility`/`assertCompatible`, the one-shot store (`once`). Nothing in `test/` talks
to a real server, and `runCli` sets `T3CTL_NO_LAUNCHD=1` so no test can touch the real launchd agent.

When the server changes shape, re-record: find (or create, with `--runtime-mode approval-required`) a thread
blocked on an approval or question, then `pnpm record-fixtures <thatThreadRef>`, and check the diff for anything
personal before committing (the recorder replaces titles, paths, prompts and message text). Add a test whenever a
live bug is fixed in one of the pure modules.

`test/fake-server.ts` is an in-process stand-in (HTTP + Effect-RPC over `ws`) for the endpoints the commands
need, including the protocol header/query-param checks and `scheduledTasks.*`; `runCli` spawns the real CLI
against it with `T3CTL_TOKEN` and a temp config dir. Use it for command wiring (flags, error JSON, exit codes,
the version gate via `fake.descriptor`), not as a protocol reference.

## Validating live

The fake server only covers wiring; validate against the real app. Cheap, safe pattern used so far:

```sh
export T3CTL_AGENT=1                      # JSON output
t3ctl env && t3ctl auth status            # server reachable, token valid
t3ctl threads -n 3                        # reads
# writes: use the `dev` project (non-git → local env), cheapest model, trivial prompt
id=$(t3ctl threads new -p dev -m sonnet -e low -t "t3ctl e2e <feature>" "Reply with exactly OK." | jq -r .threadId)
t3ctl threads wait "$id" --timeout 120
t3ctl threads archive "$id"               # always clean up smoke threads
```

Scheduler: `t3ctl schedule add --every 1h -p dev -m sonnet -e low -t "t3ctl e2e sched" "Reply with exactly OK."`,
then `schedule show|disable|enable|update <id> --at 09:30 --days mon-fri|run|remove <id>`. `schedule run` starts
a real (paid) run; archive the thread it creates. `schedule migrate` without `--apply` is read-only. Remove test
tasks afterwards. One-shots: `schedule add --once 2m --thread <smoke thread> "Reply with exactly FIRED."`, then
watch `~/.config/t3ctl/once.json` flip to `fired` and the thread answer; `schedule tick` runs the same path by hand.

Approval paths: create with `--runtime-mode approval-required` and a prompt that writes a file under `/tmp`;
`threads pending` → `threads approve`. Guard paths: run the same `threads new` twice within a minute (second
exits 6 `duplicate_thread`), then `--batch -` with 3 items; a sixth create inside the minute
exits 6 `rate_limited`. Archive everything afterwards. Snooze paths: `--draft --snooze 2h` then `unsnooze`. Never test writes
against real work threads; never archive or interrupt a thread you did not create.

Server-side failures surface as `EnvironmentInternalError`/`orchestration_dispatch_failed`; trace ids can be
grepped in `~/.t3/userdata/logs/desktop.trace.ndjson`.

## Releasing a change

`pnpm test && pnpm build` → live test → `git commit` → `git push` (remote `samzilverberg/t3ctl`, branch `main`). No CI yet.
