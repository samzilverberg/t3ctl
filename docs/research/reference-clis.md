# Third-party T3 Code CLIs/SDKs — reference notes

Sources fetched 2026-09-06 into `/tmp/t3code-refs/`:

| Ref | Package | Version | Stars | Last push | Size (src) |
|---|---|---|---|---|---|
| `tarik02/` | `t3code-cli` (bin `t3cli`) | 0.15.0 | 7 | 2026-08-24 | ~12k LOC, 200+ files |
| `majesteit/` | `@bvdm/t3code-cli` (bin `t3code`) | 0.1.2 | 3 | 2026-08-21 | ~1.7k LOC, 14 files |
| `shivamhwp/package/` | `@shivamhwp/t3code-sdk` (library only) | 0.1.0 | repo 404 (npm only) | — | ~1.6k LOC src + vendored contracts |

Upstream facts confirmed via vendored `@t3tools/contracts` (`shivamhwp/package/upstream/contracts/src/*.ts`) — useful as ground truth for the server protocol regardless of which client you read.

---

## Shared upstream protocol facts (from vendored contracts)

Files: `shivamhwp/package/upstream/contracts/src/{rpc,orchestration,auth,environment}.ts`

- **Discovery endpoint**: `GET {origin}/.well-known/t3/environment` (anonymous) → `ExecutionEnvironmentDescriptor { environmentId, label, platform, serverVersion, capabilities }`. Capabilities flags: `repositoryIdentity`, `connectionProbe`, `pullRequests`, `threadSettlement`, `threadSnooze`, `threadPinning`, `threadPinReorder`, `threadTitleRegeneration`, `serverSelfUpdate` (`environment.ts:48-86`). Use these for version-skew gating rather than parsing `serverVersion`.
- **Runtime state file** (written by running app): `~/.t3/userdata/server-runtime.json` = `{ version: 1, pid, host?, port, origin, startedAt }`. Dev builds use `~/.t3/dev/`. `T3CODE_HOME` overrides `~/.t3`. Nobody hardcodes 3773 for discovery (only shivamhwp README example uses `http://localhost:3773`).
- **HTTP API** (bearer auth): `GET /api/auth/session`, `POST /api/auth/websocket-ticket` → `{ ticket, expiresAt }`, `GET /api/orchestration/shell` (light snapshot: projects+thread shells), `GET /api/orchestration/snapshot` (full read model), `GET /api/orchestration/threads/:threadId` (detail, accepts `turnLimit`/`beforeCursor` paging), `POST /api/orchestration/dispatch` (body = `ClientOrchestrationCommand`, returns `DispatchResult { sequence }`), `POST /oauth/token` (RFC 8693 token exchange).
- **WebSocket**: `ws(s)://{origin}/ws?wsTicket=<ticket>`. Effect RPC over WebSocket, JSON serialization (`RpcSerialization.layerJson`).
- **RPC method names** (`rpc.ts:190-250`, `orchestration.ts:26-35`): `server.probe`, `server.getConfig`, `orchestration.dispatchCommand`, `orchestration.subscribeShell` (stream), `orchestration.subscribeThread` (stream), `orchestration.searchThreads`, `orchestration.getArchivedShellSnapshot`, `orchestration.getTurnDiff`, `orchestration.getFullThreadDiff`, `orchestration.getWorkflowScript`, `terminal.open|attach|write|resize|clear|restart|close`, `terminal.subscribeEvents/Metadata`, `previewAutomation.connect|respond|focusHost`, `projects.*`, `vcs.*`, `git.*`, `review.*`, `preview.*`.
- **Effect RPC wire frames** (effect@4.0.0-beta.103 `dist/unstable/rpc/RpcMessage.d.ts`, unpacked to `/tmp/t3code-refs/effect/pkg`):
  - Client→server: `{"_tag":"Request","id":"<n>","tag":"orchestration.subscribeThread","payload":{...},"headers":[["k","v"]],"traceId"?,"spanId"?,"sampled"?}`, `{"_tag":"Ack","requestId"}`, `{"_tag":"Interrupt","requestId"}`, `{"_tag":"Ping"}`, `{"_tag":"Eof"}`.
  - Server→client: `{"_tag":"Chunk","requestId","values":[...]}` (stream items; client must `Ack`), `{"_tag":"Exit","requestId","exit":{"_tag":"Success","value"}|{"_tag":"Failure","cause":{"_tag":"Fail"|"Die"|"Interrupt",...}}}`, `{"_tag":"Defect"}`, `{"_tag":"Pong"}`, `{"_tag":"ClientProtocolError"}`.
  - Request ids are client-generated string/number; all three refs let `RpcClient` generate them.
- **Stream items**: `OrchestrationThreadStreamItem = {kind:"synchronized"} | {kind:"snapshot", snapshot: ThreadDetailSnapshot} | {kind:"event", event: OrchestrationEvent}` (`orchestration.ts:1478`). Shell stream analogous; snapshot carries `snapshotSequence`, events carry `sequence`. Subscribe inputs accept `afterSequence`, `turnLimit`, `requestCompletionMarker`.
- **Commands** (`type` literal on `ClientOrchestrationCommand`): `project.create|meta.update|delete`, `thread.create|delete|archive|unarchive|settle|unsettle|snooze|unsnooze|pin|unpin|pin.reorder|meta.update|runtime-mode.set|interaction-mode.set|turn.start|turn.interrupt|approval.respond|user-input.respond|checkpoint.revert|session.stop`. Every command carries client-generated `commandId` (uuid) + `createdAt` ISO; entity ids (`projectId`, `threadId`, `messageId`) are also client-generated.
- **Events** (`OrchestrationEvent.type`): `thread.created|deleted|archived|...|meta-updated|message-sent|turn-start-requested|session-set|activity-appended|turn-diff-completed|proposed-plan-upserted|reverted`, `project.created|meta-updated|deleted`.
- **Auth scopes** (`auth.ts:84-116`): `orchestration:read`, `orchestration:operate`, `terminal:operate`, `review:write`, `relay:read` (= `AuthStandardClientScopes`); administrative adds `access:read`, `access:write`, `relay:write`. Token exchange constants: `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap`, `requested_token_type=urn:ietf:params:oauth:token-type:access_token`.

---

## 1. tarik02-org/t3code-cli (`t3cli`)

Most complete; effectively a full Effect-based reimplementation of the T3 desktop client's connection stack, reusing upstream packages via git submodule.

### 1.1 Connection / discovery
- Upstream pinned as git submodule `upstream-t3code` → pnpm workspace links `@t3tools/contracts`, `@t3tools/client-runtime`, `@t3tools/shared` (`pnpm-workspace.yaml`, `.gitmodules`, `package.json` devDeps `link:upstream-t3code/packages/...`). `scripts/sync-upstream.ts` bumps submodule + syncs catalog versions/patches (`pnpm sync-upstream --target stable|nightly|main|0.0.31`).
- URL sources, precedence (`src/config/config.ts`, `src/config/resolve/resolve.ts`, `src/config/env/env.ts`):
  1. `T3CODE_URL` + `T3CODE_TOKEN` env (must both be set, else `ConfigError`).
  2. `--environment <name>` global flag → `T3CLI_ENV` → config `default`.
  3. Stored environment in `~/.config/t3cli/config.json` (`$XDG_CONFIG_HOME` honoured).
- Local origin discovery (`src/auth/local-origin.ts`): reads `{baseDir}/userdata/server-runtime.json`, decodes `{version:1, origin}` via Effect Schema, normalizes. baseDir = `--base-dir` → `T3CODE_HOME` → `~/.t3` (`src/config/env/layout.ts`). Error text: "Make sure T3 Code is running with Network access enabled, or pass --origin manually."
- Transport (`src/connection/prepared.ts`, `src/rpc/session.ts`): `fetchRemoteEnvironmentDescriptor` (client-runtime) → `resolveRemoteWebSocketConnectionUrl({httpBaseUrl, wsBaseUrl: origin+"/ws", bearerToken})` (issues ws ticket) → `Socket.layerWebSocket(socketUrl, {openTimeout:"15 seconds"})` + `RpcClient.makeProtocolSocket({retryTransientErrors:false, retryPolicy: Schedule.recurs(0)})` + `RpcSerialization.layerJson`. After socket connect it calls `server.getConfig` (cached as `initialConfig`) and `server.probe` if `capabilities.connectionProbe`.
- HTTP used only for paged thread transcript: `GET /api/orchestration/threads/:id` with `authorization: Bearer` header via client-runtime `makeEnvironmentHttpApiClient` (`src/orchestration/layer.ts:170-215`). Everything else is WS RPC, including snapshots (takes first `snapshot` item of a subscribe stream: `getShellSnapshot`, `getThreadSnapshot`).
- Node adapter: `src/sql/node-sqlite-client.ts` wraps `node:sqlite` `DatabaseSync` into an Effect `SqlClient` (used for local auth only).

### 1.2 Auth
Three modes (`src/auth/*`):
- **`auth pair --url <pairing-url>`** (`pairing.ts`, `transport.ts`): parses token from URL hash `#token=` (fallback `?token=`), optional `?host=` for hosted relay; calls client-runtime `bootstrapRemoteBearerSession({httpBaseUrl, credential, clientMetadata:{label, deviceType:"bot", os}})` → `POST /oauth/token` token exchange → `{access_token, expires_in, scope}`. Role inferred: scope contains `access:write` → `owner` else `client`.
- **`auth local`** (`local-token.ts`): *bypasses HTTP entirely*. Reads HMAC secret `{baseDir}/userdata/secrets/server-signing-key.bin`, mints token `base64url(JSON claims).base64url(HMAC-SHA256)` with claims `{v:1, kind:"session", sid, sub, scopes: AuthAdministrativeScopes, method:"bearer-access-token", iat, exp}` (30-day TTL), then INSERTs a row into `{baseDir}/userdata/state.sqlite` table `auth_sessions` (columns `session_id, subject, scopes(json), method, client_label, client_device_type="bot", issued_at, expires_at, revoked_at...`). Checks `PRAGMA table_info(auth_sessions)` has `scopes` column (schema guard). Sets `local:true` in config, which enables cwd→project resolution.
- **Env override** `T3CODE_URL`/`T3CODE_TOKEN`.
- Storage (`src/config/persist/schema.ts`, `credential/service.ts`, `keystore/*`): config v2 `{version:2, default?, environments:{[name]:{url, local, token:{kind:"encrypted", alg:"aes-256-gcm", key:"default", nonce, ciphertext, tag}}}}`. Master key 32 bytes in OS keyring (`@napi-rs/keyring`, service `t3cli`, account `master-key`), fallback file `~/.config/t3cli/key` mode 0600 / dir 0700. AAD binds ciphertext to `"2\0{name}\0{url}\0{local}"`. Auto-migrates v1 plaintext `{url, token, local}` on first read (`persist/migration.ts`).
- Headers on the wire: HTTP `authorization: Bearer <token>`; WS auth via `?wsTicket=` query param only (no header). `auth status` calls `GET /api/auth/session`.

### 1.3 Wire protocol handling
- RPC group declared in `src/rpc/ws-group.ts`: terminal (7), orchestration (5), previewAutomation (3), `server.probe`, custom narrowed `server.getConfig` schema (`CliServerConfig` = `{environment:{capabilities:{connectionProbe}}, providers, threadSnapshotPagination?}` — deliberately loose so server adding fields doesn't break).
- Retry (`src/rpc/layer.ts`, `operation.ts`): connection open retried `Schedule.exponential("100 millis")` up to 4 while error is `ConnectionTransientError`; each RPC `run`/`subscribe` retried same schedule while `RpcClientError`, and on `RpcClientError` the cached connection is dropped (`rpc.disconnect`) so next attempt reconnects. No sequence-resume on stream retry (a re-subscribed stream simply yields a new snapshot; `watchShellSnapshots` resets reducer on new snapshot).
- Write-then-confirm pattern (`src/application/shell-sequence.ts`): dispatch → `DispatchResult.sequence` → subscribe shell, wait until `snapshotSequence|sequence >= dispatch.sequence` → re-fetch shell snapshot → look up created entity. Used by `project add`, `start`, `action add/update`.
- Thread wait (`src/application/thread-wait.ts`, `src/domain/thread-lifecycle.ts`): subscribe thread, reduce `thread.message-sent` (streaming deltas keyed by messageId) + `thread.session-set` into an `OrchestrationThread`; emit `WaitEvent` `{type:"thread"|"message"|"status"|"done"}`; done when `!isThreadActive && isThreadCompleteEnough` (assistant message after last user message, or session `error|interrupted`). `pending` status derived when session/latestTurn null and last message is user.
- Example ndjson (`skills/t3code-cli/reference/commands.md`):
  ```
  {"type":"dispatch","sequence":42}
  {"type":"thread","thread":{},"messageCount":3}
  {"type":"message","message":{"role":"assistant","text":"..."}}
  {"type":"status","status":"running","threadId":"..."}
  {"type":"done","thread":{},"latestAssistantMessage":{}}
  ```

### 1.4 Command surface (`src/cli/app.ts`, `skills/t3code-cli/reference/commands.md`)
```
t3cli
├── auth pair|local|status                       (W W R)
├── env list|use|remove                          (R W W)  -- local config only
├── project list|add|delete                      (R W W)
├── model list [--all] [--provider]              (R)  -- from server.getConfig providers
├── list|search|show|transcript|wait             (R)  -- root-level thread reads
├── ask [msg] --project|--thread [--archive ...] [--timeout] (W) one-shot Q&A, auto-archive
├── start [msg] [--wait] | send [msg] [--wait]   (W)
├── thread approve|respond|archive|unarchive|interrupt|settle|unsettle|snooze|unsnooze|pin|unpin|update|delete|callback (W)
├── action list|run|add|update|delete            (R W W W W) -- project scripts via project.meta.update
└── terminal list|create|attach|read|stream|wait|write|destroy (R W W R R R W W)
```
Global: `--environment`, `--format auto|human|json|ndjson`, `--completions bash|zsh|fish|sh`, `--log-level`. Scope env vars: `T3CODE_PROJECT_ROOT`→`T3CODE_PROJECT_ID`→cwd(local only); `T3CODE_WORKTREE_PATH`; `T3CODE_THREAD_ID`; `T3CLI_AGENT`. Project ref resolution (`src/domain/helpers.ts`): id → exact `workspaceRoot` → cwd descendant of workspaceRoot → thread `worktreePath` match.

### 1.5 Stack / build
- `effect@4.0.0-beta.103` (+ patched via upstream patches), `@effect/platform-node`, `effect/unstable/cli` (Command/Flag/Argument — not commander), `@napi-rs/keyring`, `marked` + `marked-terminal` (transcript rendering), `string-width`, `wrap-ansi`. Node >=24 (uses `node:sqlite`).
- Build: `vite-plus` (`vp pack`) bundling everything except `@napi-rs/keyring`; ESM; many subpath exports (`t3code-cli/auth`, `/rpc`, `/connection`, `/contracts`, `/client-runtime/*`, `/shared/*`) — it doubles as a library. `T3CLI_VERSION` define injected. Tests: vitest via vite-plus + `@effect/vitest`. Lint: oxlint-style rules (`strict-boolean-expressions`). Releases via changesets; Nix flake + `nix profile install`.
- CI: `.github/workflows/{check,release,nix-pnpm-deps}.yml`.

### 1.6 Ideas worth borrowing / gotchas
- Agent-first output: `--format auto` picks `human` only on TTY and not `CI|CODEX_CI|CODEX_THREAD_ID|T3CLI_AGENT`; ndjson for streams; progress to stderr, answer to stdout (`src/cli/format/output.ts`, `wait-events.ts`).
- `SKILL.md` + `reference/{commands,setup}.md` installable via `npx skills add`; includes "self-identity" recipe (`t3cli show --format json | jq .modelSelection`) and `--force` self-action guard: refuses archive/delete/interrupt on the thread equal to `T3CODE_THREAD_ID` when in agent env (`src/cli/interaction/self-action.ts`, issues #56/#68).
- `thread callback --from A --thread B --prompt ... --background` spawns detached `node <cli> ...` watcher (`src/cli/threads/callback.ts`).
- `ask` lifecycle: create temp thread, wait, archive on-success, `--timeout`, rejects busy/archived/pending-approval threads (`src/cli/ask-lifecycle.ts`, `error.ts` typed errors).
- Capability-gated commands (settle/snooze/pin) + narrowed `server.getConfig` schema for forward compat (CHANGELOG 0.13.0 "Keep RPC connections compatible with server config fields the CLI does not use").
- Gotchas: heavy Effect v4 beta dependency + upstream patches; must track upstream submodule; `auth local` writes directly to the app's SQLite and depends on `auth_sessions` schema — brittle across upstream schema changes; 30-day admin-scope token minted silently. Open issues (#91-#99): persistent runtime/interaction modes, project meta update, provider refresh, settings, usage, terminal clear/restart, "update to compatible T3 release" — i.e. lag behind upstream is the recurring cost.

---

## 2. MajesteitBart/t3code-cli (`t3code`)

Narrow purpose: "hand over cwd/repo to a new T3 thread". Plain Node + commander, HTTP only, auth delegated to upstream `t3` CLI.

### 2.1 Connection / discovery (`src/runtime.ts`)
- Candidates in order: `--origin`/`config.origin`/`T3CODE_CLI_ORIGIN`; then `{T3CODE_HOME|~/.t3}/{userdata,dev}/server-runtime.json` (validates `version===1`, `pid`, `port`, `origin`, `startedAt`). Each candidate probed with `GET /.well-known/t3/environment` (2.5s timeout, `connection: close`) requiring `environmentId` + `serverVersion`.
- If none reachable and `startDesktopIfNeeded`, launches desktop via `t3code://app/` protocol (`open`/`xdg-open`/`explorer.exe`, `src/platformOpen.ts`) and polls every 500ms for 30s. `hasProtocolHandler` only implemented on Windows (registry query); returns false elsewhere.
- Transport: global `fetch`, `AbortSignal.timeout(30_000)`, `connection: close` header (`src/api.ts`). No WebSocket at all.
- Read fast-path (`src/localProjects.ts`): opens `{stateDir}/state.sqlite` read-only with `node:sqlite` and `SELECT ... FROM projection_projects WHERE deleted_at IS NULL` — avoids auth for `projects list/resolve`. Falls back to HTTP if DB/schema unavailable.

### 2.2 Auth (`src/api.ts`, `src/process.ts`)
- Shells out to upstream CLI: `t3 auth session issue --json --ttl 2m --label t3code-cli --subject t3code-cli --base-dir ~/.t3` → `{sessionId, token}`; after work, `t3 auth session revoke <sessionId> --base-dir ...` in `finally`. `t3` resolved: config `t3Command[]` → bundled `node_modules/t3/dist/bin.mjs` (dep `t3@0.0.28`) → `t3` on PATH → `npx --yes t3@latest`.
- Token only in memory; header `authorization: Bearer <token>`. Nothing persisted. Own config at `$XDG_CONFIG_HOME/t3code-cli/config.json` (or `%APPDATA%`), `T3CODE_CLI_CONFIG`, all keys overridable via `T3CODE_CLI_*` env (`src/config.ts`).

### 2.3 Wire protocol
HTTP only: `GET /api/orchestration/shell` (fallback `/snapshot`), `POST /api/orchestration/dispatch`. Command bodies built by hand (`src/service.ts:1705-1916`): `project.create` (with `createWorkspaceRootIfMissing:false`, `defaultModelSelection`), `thread.create` (`runtimeMode`, `interactionMode`, `branch`, `worktreePath:null`), `thread.turn.start` (`message:{messageId, role:"user", text, attachments:[]}`, `titleSeed`, optional `bootstrap:{createThread, prepareWorktree:{projectCwd, baseBranch, startFromOrigin}, runSetupScript:true}` for atomic worktree creation on >=0.0.28). No subscriptions, no wait — fire-and-forget, then open UI. On turn-start failure it dispatches `thread.delete` to clean up (`THREAD_START_FAILED`).
- Version gating by `serverVersion` semver compare (`MINIMUM_WORKTREE_BOOTSTRAP_VERSION=0.0.28`, `MODERN_DEFAULTS_VERSION=0.0.29` switches default model `gpt-5.4`→`gpt-5.6-sol` and `newWorktreesStartFromOrigin` default).
- Reads T3's own settings for parity: `{stateDir}/settings.json` (`defaultThreadEnvMode`, `newWorktreesStartFromOrigin`) and repo `t3.json`.

### 2.4 Command surface (`src/cli.ts`)
```
t3code [--json] [--config] [--t3-home] [--origin]
  doctor                                   (R) checks node/git/t3 cli/t3 home/server/protocol handlers
  config path|show|set <key> <value>       (R R W-local)
  projects list | resolve --cwd | ensure --project-policy create|existing [--dry-run]  (R R W)
  threads create  --prompt|--prompt-file|--stdin [--provider --model --speed --thinking-effort --permission --mode --checkout --open --dry-run]  (W)
  handover        (same as threads create; resolves git root, ensures project)  (W)
  request get <path>                       (R) raw HTTP escape hatch
```
Output: `--json` → `{ok:true, data}` on stdout / `{ok:false, error:{code, message, details?}}` on stderr with stable `code` strings (`src/output.ts`, `errors.ts`).

### 2.5 Stack / build
`commander@14`, `t3@0.0.28` (runtime dep, for auth), Node >=22.16 (`node:sqlite`). `tsc` build to `dist/`, vitest, pnpm. npm trusted publishing (OIDC) via `publish.yml`. Ships `skills/use-t3code-cli/SKILL.md` + `agents/openai.yaml`; `AGENTS.md` for contributors. Extra `integrations/` (React split button + Node bridge that spawns `t3code --json handover` with prompt on stdin).

### 2.6 Ideas / gotchas
- Borrow: `doctor` command shape; `--dry-run --json` printing exact commands; `--stdin` prompt; `{ok,data}/{ok,error.code}` envelope; walking to git root (`workspaceMode repo|folder`) + `pathsEqual` normalization; reading app `settings.json`/`t3.json` for defaults; ephemeral 2-minute session issue+revoke; auto-launch desktop via protocol URL then poll.
- Gotchas: no streaming/wait; depends on upstream `t3` CLI binary existing (bundled 0.0.28 may mismatch running app); `hasProtocolHandler` is Windows-only so `openMode auto` never deep-links on macOS/Linux (falls to browser URL `/{environmentId}/{threadId}`); `exactThread:false` on current desktop (only `t3code://app/` reveal exists; `t3://thread/<id>` is a *proposed* scheme); provider option ids guessed (`serviceTier`,`fastMode`,`reasoningEffort`,`effort`,`reasoning` all set) — README admits "T3 applies the option ids supported".

---

## 3. @shivamhwp/t3code-sdk (library, npm only)

README: "DO NOT USE IT... experimentation". Clean, small, promise-based SDK over HTTP + Effect RPC WebSocket. Source shipped in tarball (`package/src/*.ts`), plus vendored `upstream/contracts` trimmed to import closure and a lockfile `upstream/t3code.lock.json` (integrity-hashed pin, `bun run sync:upstream <commit>`).

### 3.1 Connection (`src/http.ts`, `src/rpc.ts`, `src/client.ts`)
- No discovery: caller passes `baseUrl` (README example `http://localhost:3773`). `connect()` first fetches `.well-known/t3/environment` anonymously, optionally asserts `requiredCapabilities`.
- HTTP via injectable `fetch`; WS via `Socket.layerWebSocket(url,{openTimeout:"15 seconds"})` + `Socket.layerWebSocketConstructorGlobal` (Node 22 global WebSocket) + `RpcClient.makeProtocolSocket({retryTransientErrors:false, retryPolicy:Schedule.recurs(0)})` + `RpcSerialization.layerJson`, wrapped in `ManagedRuntime`. Probes `server.probe` right after connect.
- WS URL: `POST api/auth/websocket-ticket` → `ws(s)://.../ws?wsTicket=<ticket>` (`http.ts:920-929`).

### 3.2 Auth (`src/http.ts:755-888`)
- Either `bootstrapToken` (from `t3 serve` stdout) → `POST oauth/token` form-encoded: `grant_type=urn:ietf:params:oauth:grant-type:token-exchange&subject_token=<bootstrap>&subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap&requested_token_type=urn:ietf:params:oauth:token-type:access_token&scope=orchestration:read orchestration:operate ...&client_label=&client_device_type=bot&client_os=` → `{access_token, expires_in, ...}`;
- or `accessToken: string | () => Promise<string>` (e.g. from `t3 auth session issue --token-only`) with optional `refreshAccessToken`.
- Proactive refresh 30s before `expires_in`; single retry on 401/403. Header `authorization: Bearer`. Nothing persisted — SDK, not CLI.

### 3.3 Wire protocol handling
- Narrow RPC group (`src/rpc.ts:1273`): `server.probe`, `orchestration.dispatchCommand|getWorkflowScript|getTurnDiff|getFullThreadDiff|searchThreads|getArchivedShellSnapshot|subscribeShell|subscribeThread`. Generic typed `request(tag,input)` / `stream(tag,input)` → `AsyncIterable` via `Stream.toAsyncIterable`.
- Writes go over **HTTP dispatch** (`POST api/orchestration/dispatch`), reads over HTTP snapshot endpoints; WS used only for subscriptions + health.
- Reconnect (`src/gateway.ts`): `T3Gateway` lazily owns one transport; on any error resets and retries once for unary; for streams `resubscribe()` loops with exponential backoff `reconnectDelay(attempt, {baseMs:1000, maxMs:16000, jitter:0.2})`, passes `afterSequence` = last seen sequence and **drops replayed items with `sequence <= last`** (`itemSequence()` reads `snapshot.snapshotSequence` / `event.sequence`). `AbortSignal` plumbed everywhere; `requestCompletionMarker:true` sent on subscribes.
- Turn correlation (`src/run.ts`): `threads.run({threadId,prompt})` dispatches `thread.turn.start`, subscribes `afterSequence: receipt.sequence`, and determines ownership via `messageId`+`createdAt` (`thread.turn-start-requested` event or snapshot `latestTurn.requestedAt === request.createdAt`). Terminal via `thread.session-set` (`ready`→completed, `interrupted|stopped`→interrupted, `error`→error w/ `lastError`). Assistant text accumulated from `thread.message-sent` with `streaming` flag (delta vs full). Emits `onWorking/onTitle/onText(delta,text)/onActivity/onStatus`; `activityStatus()` filters noise kinds `context-window.updated`, `checkpoint.captured`. Abort → dispatches `thread.turn.interrupt`. `threads.stream()` = same as async generator of `RunEvent` (`dispatched|working|title|text|activity|status|completed`). `threads.wait({threadId,messageId,createdAt,afterSequence})` re-attaches after process restart.

### 3.4 API surface (`src/client.ts`, `src/resources.ts`)
```
T3Code.connect(opts) → t3
t3.environment() / capabilities() / session() / shell() / health()   (R)
t3.projects.list() / create({workspaceRoot,...}) / delete()           (R W W)
t3.threads.list(projectId?) / get(id)                                 (R)
t3.threads.create / delete / send / interrupt / respondToApproval     (W)
t3.threads.run(input, hooks) / stream(input) / wait(ref)              (W + subscribe)
t3.subscribeShell({afterSequence, signal}) / subscribeThread(id, {turnLimit})  (R stream)
t3.raw.dispatch(cmd) / raw.request(path, init) / t3.rpc()             escape hatches
await using t3  (Symbol.asyncDispose)
```
Caller may supply deterministic `commandId/projectId/threadId/messageId` (idempotent retries).

### 3.5 Stack / build
Single runtime dep `effect@4.0.0-beta.103`. `tsup` ESM + dts + sourcemap (dist 315 KB — bundles vendored contracts). `oxfmt`, vitest 4, bun as PM, TypeScript 6 dev, Node >=22.16. Consumers need `skipLibCheck` (effect beta d.ts). Exports `.` (dist) and `./source` (raw TS).

### 3.6 Ideas / gotchas
- Borrow: gateway pattern (lazy single WS, reset-on-error, sequence-resume with replay dedupe); turn ownership correlation by `messageId+createdAt`; `afterSequence: dispatch.sequence` to skip stale history; `AsyncGenerator` event stream + `await using`; `requiredCapabilities` check; exact-commit contract pinning with integrity hash instead of submodule.
- Gotchas: no approval/user-input handling inside `run()`; no local discovery/credential storage; README explicitly unstable; assumes Node global `WebSocket`.

---

## Comparison matrix

| Concern | tarik02 `t3cli` | majesteit `t3code` | shivamhwp SDK |
|---|---|---|---|
| Discover origin | `~/.t3/userdata/server-runtime.json` (`T3CODE_HOME`), or stored env URL | same file, `userdata` then `dev`; probes `.well-known`; auto-launch via `t3code://app/` | none (caller passes `baseUrl`) |
| Transport | Effect RPC over WS (all ops) + HTTP for paged transcript | HTTP fetch only | HTTP for reads/writes, WS for streams |
| Auth | pair (oauth token-exchange) / local (mint HMAC token + insert into app sqlite) / env | spawn `t3 auth session issue` (2m TTL) + revoke | bootstrap token exchange or supplied bearer, refresh hook |
| Cred storage | AES-256-GCM in `~/.config/t3cli/config.json`, key in OS keyring or 0600 file, multi-env | none (memory only) | none |
| Wait/stream | subscribeThread reducer → ndjson events; `--wait`, `ask`, `callback` | none | `run/stream/wait` with sequence resume + reconnect backoff |
| Write confirm | wait for shell `sequence >= dispatch.sequence` then re-snapshot | none | `afterSequence: receipt.sequence` on thread subscribe |
| CLI framework | `effect/unstable/cli` | commander | n/a |
| Contract source | git submodule + pnpm link, `sync-upstream` script | hand-typed loose types, semver gating | vendored contracts w/ lockfile hash |
| Agent docs | SKILL.md + reference/*.md, `T3CLI_AGENT`, self-action guard | SKILL.md, `--json` envelope, `doctor` | README only |
| Build | vite-plus bundle, many subpath exports, changesets, Nix | tsc, npm trusted publish | tsup |
