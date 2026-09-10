# T3 Code (t3code) — client protocol research for a local CLI

Source: https://github.com/pingdotgg/t3code, tag `v0.0.38` (commit c0995d2e), checked out at
`/tmp/t3code-src`. All paths below are relative to that root. `apps/server` = npm package `t3`
(bin `t3` → `dist/bin.mjs`). Note: `package.json` versions inside the tag still read `0.0.37`
(bumped at publish time); tag `v0.0.38` is what's installed locally.

---

## 0. TL;DR for building the CLI

- Transport = **Effect RPC over a single WebSocket at `GET /ws`**, **JSON** serialization
  (`RpcSerialization.layerJson`), plus a smaller **plain HTTP API** (`/api/orchestration/*`,
  `/api/auth/*`, `/oauth/token`) that already covers list/read/create/dispatch. For a CLI that does
  "list threads, read thread, create project/thread, send message", the HTTP API alone is enough;
  use the WS only for live streaming / wait-for-idle.
- Auth = OAuth-shaped **bearer session token** (`Authorization: Bearer <token>`), scopes
  `orchestration:read orchestration:operate terminal:operate review:write relay:read`.
  Accepted on HTTP requests *and directly on the `/ws` upgrade* (header), or via a 5-minute
  `?wsTicket=` obtained from `POST /api/auth/websocket-ticket`.
- Simplest local-only token path: the same thing `t3 project add` and `t3 auth session issue`
  do — open the server's SQLite DB at `~/.t3/userdata/database` and mint a session locally, or
  just shell out: `t3 auth session issue --token-only` (admin scopes, 30d TTL). Alternatively
  `t3 auth pairing create` → exchange at `POST /oauth/token`.
- Server discovery: read `~/.t3/userdata/server-runtime.json` (`{pid, host, port, origin,...}`).
  Verify with `GET /.well-known/t3/environment`.
- Reference implementation of exactly this pattern: `apps/server/src/cli/project.ts`
  (`tryResolveLiveProjectExecutionMode`, `fetchLiveOrchestrationSnapshot`,
  `dispatchLiveOrchestrationCommand`).

---

## 1. Transport

### 1.1 One WebSocket RPC endpoint

- Route: `HttpRouter.add("GET", "/ws", ...)` — `apps/server/src/ws.ts:2516-2521`.
- Server: `RpcServer.toHttpEffectWebsocket(WsRpcGroup, { disableTracing: true })` with
  `RpcSerialization.layerJson` — `apps/server/src/ws.ts:2539-2549`. So wire format is Effect RPC's
  JSON framing (not msgpack, not ndjson). `effect` version is `4.0.0-beta.103`
  (`pnpm-workspace.yaml:48`), modules `effect/unstable/rpc/*`.
- Client: `RpcClient.make(WsRpcGroup)` + `RpcClient.makeProtocolSocket` +
  `Socket.layerWebSocket(connection.socketUrl)` + `RpcSerialization.layerJson` —
  `packages/client-runtime/src/rpc/protocol.ts`, `packages/client-runtime/src/rpc/session.ts:133-185`.
- Same `/ws` used by web UI, Electron renderer, mobile, hosted web (`app.t3.codes`). SSH and
  relay/tunnel access just change the URL the client dials (`docs/internals/remote.md`).
- Optional query params read on upgrade for attribution only: `clientSurface`,
  `clientAppVersion`, `clientDeviceType`, `clientOs`, `clientWebDeployment`
  (`apps/server/src/ws.ts:388-420`). Malformed → ignored.
- WS compression: `perMessageDeflate: true` (`apps/server/src/server.ts:227-236`).

### 1.2 Plain HTTP API (Effect `HttpApi`), defined in `packages/contracts/src/environmentHttp.ts`

| Group | Method+path | Auth | Notes |
|---|---|---|---|
| metadata | `GET /.well-known/t3/environment` | none | `ExecutionEnvironmentDescriptor` (env id, auth policy). Used by `t3 pair` to confirm a live server. L411-415 |
| auth | `GET /api/auth/session` | optional bearer | `AuthSessionState` {authenticated, auth descriptor, scopes, sessionMethod, expiresAt} L419 |
| auth | `POST /api/auth/browser-session` | bootstrap credential in body | sets cookie (browser only) L426 |
| auth | `POST /oauth/token` | form-urlencoded token exchange | bearer/DPoP session from a pairing credential L433 |
| auth | `POST /api/auth/websocket-ticket` | bearer | `{ticket, expiresAt}` 5-min ticket for `/ws?wsTicket=` L441 |
| auth | `POST /api/auth/pairing-token` | bearer w/ `access:write` | mint new pairing credential L448 |
| auth | `GET /api/auth/pairing-links`, `POST .../revoke` | `access:read`/`access:write` | L456-469 |
| auth | `GET /api/auth/clients`, `POST .../revoke`, `POST .../revoke-others` | `access:*` | L471-491 |
| orchestration | `GET /api/orchestration/snapshot` | bearer `orchestration:read` | **`OrchestrationReadModel`** = {snapshotSequence, projects[], threads[] (full, with messages), updatedAt} L509 |
| orchestration | `GET /api/orchestration/shell` | bearer | `OrchestrationShellSnapshot` (lightweight project/thread list, no messages) L516 |
| orchestration | `GET /api/orchestration/threads/:threadId?turnLimit=&beforeCursor=` | bearer | `OrchestrationThreadDetailSnapshot` L523 |
| orchestration | `POST /api/orchestration/dispatch` | bearer `orchestration:operate` | body = `ClientOrchestrationCommand`, returns `DispatchResult {sequence}` L532 |
| pullRequests | `POST /api/pull-requests/diff` | bearer | L542 |
| connect | `/api/connect/*`, `/api/t3-connect/*` | relay/T3 Connect internals | L556-615 |
| — | `GET /api/assets/...`, `PUT /api/attachments/upload/<token>` | signed URLs | `apps/server/src/http.ts:314-385` |
| — | `POST /api/observability/v1/traces` | | OTLP proxy `http.ts:49` |
| — | `/mcp` | `Authorization: Bearer <mcp token>` | MCP server for preview tools only, see §5 |

Everything else (static SPA, `/pair`, dev proxy) is `staticAndDevRouteLayer` (`http.ts:386`).

### 1.3 The processes you see locally

| Process | What it is | Port | Data dir |
|---|---|---|---|
| Electron app listening on `*:3773` | Desktop-embedded backend. Electron main spawns `t3` with `--bootstrap-fd 3` and `mode: "desktop"`; port default `DEFAULT_DESKTOP_BACKEND_PORT = 3773` (`apps/desktop/src/app/DesktopApp.ts:32`, `apps/server/src/config.ts:20`). Because your `desktop-settings.json` has `serverExposureMode: "network-accessible"`, bind host is `0.0.0.0` instead of `127.0.0.1` (`apps/desktop/src/backend/DesktopServerExposure.ts:30-31,100-135`). | 3773 | `~/.t3/userdata` (`apps/desktop/src/app/DesktopStatePaths.ts:18-31`) |
| `t3 serve` (runtime 0.0.38) on `localhost:58881` | The **background service** (`t3 service install`, launchd `com.t3tools.t3code.service`). Launcher `~/.t3/runtime/service-launcher.mjs` spawns `~/.t3/runtime/versions/<v>/node_modules/t3/dist/bin.mjs serve` with `T3CODE_HOME=~/.t3` (`apps/server/src/serviceLauncher.ts:46-50,405`, `apps/server/src/cloud/bootService.ts:72,132`). In `web` mode with no `--port`, the server calls `findAvailablePort(3773)` (`apps/server/src/cli/config.ts:255-266`) — 3773 is taken by the desktop, hence 58881. Host defaults to `127.0.0.1` (`server.ts:228`). | 58881 (dynamic) | **also `~/.t3/userdata`** (same SQLite DB, same `server-runtime.json` — last writer wins) |
| `cloudflared tunnel run` | T3 Connect managed relay tunnel, spawned by the `t3 serve` process (`apps/server/src/cloud/ManagedEndpointRuntime.ts:227`). Exposes that server to `app.t3.codes`/mobile via a Cloudflare hostname; the relay Worker only brokers credentials (`docs/internals/remote.md` "Relay-tunneled access"). Not needed locally. | — | secrets in `~/.t3/userdata/secrets/*.bin` |

**Which to connect to:** Both processes serve the *same* database, so thread/project lists are
identical. Live provider sessions (running agents) are owned by whichever process started them;
`thread.turn.start` dispatched to process A runs the agent inside A. The desktop UI talks to
`:3773`, so if you want your CLI-started turns to show up streaming in the desktop window and to
be driven by the same process, **target `http://127.0.0.1:3773`**. If you want headless/always-on
behaviour, target the service (58881). Discover the service's current port from
`~/.t3/userdata/server-runtime.json` (`apps/server/src/serverRuntimeState.ts:11-20`:
`{version:1, pid, host?, port, origin, devUrl?, startedAt}`) — but note it's overwritten by
whichever of the two servers started last; check `pid` and fall back to probing
`/.well-known/t3/environment` on 3773.

---

## 2. Auth

### 2.1 Model (`docs/internals/environment-auth.md`, `packages/contracts/src/auth.ts`)

Capability scopes on a session:

```
orchestration:read     snapshots, subscriptions, config, FS/VCS reads
orchestration:operate  dispatch commands (create/send/etc), mutate workspace
terminal:operate       terminals
review:write           review diff previews
access:read / access:write   pairing links & client sessions (admin)
relay:read / relay:write     T3 Connect relay
```

Ordinary pairing → `orchestration:read orchestration:operate terminal:operate review:write relay:read`.
Desktop bootstrap and CLI-issued admin sessions additionally get `access:read access:write relay:write`
(`AuthAdministrativeScopes`).

Auth policy descriptor (`apps/server/src/auth/EnvironmentAuthPolicy.ts:16-50`):
`mode=desktop && loopback host` → `desktop-managed-local`; `mode=desktop && non-loopback` (your case,
0.0.0.0) → `remote-reachable` with bootstrap methods `["desktop-bootstrap","one-time-token"]`;
`mode=web && loopback` → `loopback-browser`. **`network-accessible` does not relax auth** — it only
changes the bind host (and therefore the cookie name and descriptor). There is *no* loopback-trust
bypass: every request/upgrade must carry a credential (`EnvironmentAuth.ts:626-637` fails with
`ServerAuthMissingCredentialError` when none). `unsafe-no-auth` exists as a literal in the contract
but no code path in this tag sets it.

### 2.2 Credential kinds

1. **Bootstrap credentials** (one-shot, exchanged for a session):
   - `one-time-token` pairing credential — default TTL 5 min (`PairingGrantStore.ts:241`), single
     use. Minted by `t3 pair`, `t3 serve` startup, `t3 auth pairing create`, desktop "Create Link",
     or `POST /api/auth/pairing-token` (needs `access:write`).
   - `desktop-bootstrap` — random token the Electron main process generates and passes to the
     server over fd 3 (`DesktopBackendConfiguration.ts:490,504`); seeded as an *unbounded-use*
     grant with admin scopes and 24 h TTL (`PairingGrantStore.ts:311-329`). Lives only in the
     Electron process memory; not on disk. Not usable from your CLI.
2. **Session credentials** (steady-state):
   - `bearer-access-token` — opaque, HMAC-signed with `~/.t3/userdata/secrets/server-signing-key.bin`
     (`SessionStore.ts:413`, `ServerSecretStore.ts:169`), rows in SQLite. TTL 30 d
     (`SessionStore.ts:414`). Sent as `Authorization: Bearer <token>`.
   - `browser-session-cookie` — same session, cookie transport (name derived per instance,
     `auth/utils.ts:30-52`). Browser only.
   - `dpop-access-token` — proof-of-possession variant used by relay clients, 1 h TTL. Ignore.
3. **WebSocket ticket** — `POST /api/auth/websocket-ticket` with bearer → `{ticket, expiresAt}`
   (5 min, `SessionStore.ts:415`); append `?wsTicket=` to `/ws`. **Optional for a Node client**:
   `authenticateWebSocketUpgrade` first looks for `wsTicket`, else falls back to
   `authenticateRequest(request)` which reads the `Authorization` header
   (`EnvironmentAuth.ts:982-1001`). Browsers can't set WS headers, hence the ticket; Node `ws`
   can.

### 2.3 What `t3 pair` does (`apps/server/src/cli/pair.ts`)

Header comment L2-11. Steps:
1. Locate a running server: read `server-runtime.json` (worktree `.t3` first, else `~/.t3`),
   `kill -0 pid` liveness check, then `GET <origin>/.well-known/t3/environment` (L232-300).
2. Build a `ServerConfig` pointed at that state dir and open the **same SQLite DB directly**
   (`EnvironmentAuth.runtimeLayer` incl. `SqlitePersistenceLayer`) — L304-346.
3. `environmentAuth.createPairingLink({ subject: "one-time-token", ttl, label })` — L435-444.
   Default scopes = the ordinary client scopes.
4. Print QR + `Pairing URL: <origin>/pair#token=<credential>` + `Token: <credential>` (L175-190).
   `--tailscale` publishes via Tailscale Serve first. Warns if origin is loopback (L514-516).

It never talks to the server's HTTP API for minting; it writes the grant into the shared DB, and the
running server picks it up (grants table). Consequence: `t3 pair` is safe to run against a running
server, and so is any local process that opens the DB the same way.

### 2.4 How a paired client turns a token into a session

`POST /oauth/token`, `Content-Type: application/x-www-form-urlencoded` (`auth.ts` `AuthTokenExchangeRequest`):

```
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token=<pairing credential>
subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap
requested_token_type=urn:ietf:params:oauth:token-type:access_token
scope=orchestration:read orchestration:operate terminal:operate review:write relay:read
client_label=my-cli   client_device_type=desktop   client_os=darwin      (optional)
```
→ `{access_token, issued_token_type, token_type:"Bearer", expires_in:2592000, scope}`.
Requested scopes must be ⊆ the grant's. Client-side reference:
`packages/client-runtime/src/authorization/remote.ts` (`bootstrapRemoteBearerSession`,
`issueRemoteWebSocketTicket`, `resolveRemoteWebSocketConnectionUrl` L219-247).

### 2.5 Simplest local paths (pick one)

A. **Shell out to the installed CLI** (zero DB code):
```
TOKEN=$(t3 auth session issue --token-only --label my-cli --ttl 30d)   # admin scopes, direct DB
# or non-admin:  CRED=$(t3 auth pairing create --token-only)  then POST /oauth/token
```
`apps/server/src/cli/auth.ts:84-115,162-196`. Both open `~/.t3/userdata/database` directly via
`EnvironmentAuth.runtimeLayer`; `--base-dir` / `T3CODE_HOME` override.
Note the installed binary is `~/.t3/runtime/versions/0.0.38/node_modules/t3/dist/bin.mjs` (or
`npx t3@0.0.38`). Both 3773 and 58881 accept the resulting token since they share the DB + signing key.

B. **Do what `t3 project add` does in-process** (`cli/project.ts:199-240,311-333`): issue a session
via `environmentAuth.issueSession({scopes: AuthAdministrativeScopes, label})`, use it over HTTP,
revoke on exit. Requires bundling server internals (SQLite via `@effect/sql-sqlite-bun`/node) — heavier.

C. Ask the *user* for a pairing link once (desktop Settings → Connections → Create Link, or
`t3 pair`), exchange at `/oauth/token`, persist the 30-day bearer in your own config file. Pure HTTP,
no DB, works against remote servers too. This is what mobile does.

### 2.6 On-disk locations (`apps/server/src/config.ts:104-140`, base `~/.t3`, state `~/.t3/userdata`)

```
~/.t3/userdata/database                 SQLite (sessions, pairing grants, orchestration events)
~/.t3/userdata/server-runtime.json      live server pid/port/origin
~/.t3/userdata/secrets/*.bin            0700 dir; server-signing-key.bin (session HMAC), cloud-* relay secrets
~/.t3/userdata/settings.json, keybindings.json, themes/, attachments/, logs/server.log, logs/server.trace.ndjson
~/.t3/userdata/desktop-settings.json    Electron-only (serverExposureMode etc.)  DesktopEnvironment.ts:203
~/.t3/runtime/{service-launcher.mjs, service-state.json, versions/<v>/...}
~/.t3/worktrees/, ~/.t3/caches/
```
`clerk-tokens.json` is not referenced anywhere in this tag's source; it's desktop-side T3 Connect
(Clerk) account state — irrelevant to local server auth. Do **not** try to read `secrets/*.bin`
to forge tokens; use the CLI/DB path above.

Env vars: `T3CODE_HOME`, `T3CODE_PORT`, `T3CODE_HOST`, `T3CODE_MODE`, `T3CODE_NO_BROWSER`,
`T3CODE_LOG_LEVEL`, `T3CODE_BOOTSTRAP_FD` (`cli/config.ts:100-130`).

---

## 3. RPC surface

All WS method names live in `packages/contracts/src/rpc.ts:209-335` (`WS_METHODS`) and
`packages/contracts/src/orchestration.ts:27-37` (`ORCHESTRATION_WS_METHODS`); the group is
`WsRpcGroup` (`rpc.ts:1029-1132`). Required scope per method: `apps/server/src/auth/RpcAuthorization.ts`
(`RPC_REQUIRED_SCOPES`). R = `orchestration:read`, W = `orchestration:operate`, T = `terminal:operate`,
RV = `review:write`, S = streaming (`stream: true`).

### 3.1 Orchestration (the ones you want)

| Method (`_tag`) | Payload → Success | Scope | rpc.ts |
|---|---|---|---|
| `orchestration.dispatchCommand` | `ClientOrchestrationCommand` → `DispatchResult {sequence}` | W | 906 |
| `orchestration.subscribeShell` S | `{afterSequence?, requestCompletionMarker?}` → `OrchestrationShellStreamItem` | R | 954 |
| `orchestration.subscribeThread` S | `{threadId, afterSequence?, requestCompletionMarker?, turnLimit?}` → `OrchestrationThreadStreamItem` | R | 961 |
| `orchestration.getArchivedShellSnapshot` | `{}` → `OrchestrationShellSnapshot` (archived threads) | R | 945 |
| `orchestration.searchThreads` | `{query (2..200 chars), limit? 1..50}` → `{matches:[{threadId, projectId, source, snippet, messageCreatedAt}]}` | R | 939 |
| `orchestration.getTurnDiff` | `{threadId, fromTurnCount, toTurnCount, ignoreWhitespace?}` → `{threadId, diff, from.., to..}` | R | 924 |
| `orchestration.getFullThreadDiff` | `{threadId, toTurnCount, ignoreWhitespace?}` → same | R | 930 |
| `orchestration.getWorkflowScript` | `{threadId, scriptPath}` → `{scriptPath, contents, truncated}` | R | 915 |

There is no `thread.list`/`project.list` RPC: lists come from the shell subscription snapshot
(WS) or `GET /api/orchestration/shell|snapshot` (HTTP). `WS_METHODS.projectsList/Add/Remove` are
declared (`rpc.ts:210-212`) but **not** in `WsRpcGroup` — dead names.

**`ClientOrchestrationCommand`** union (`orchestration.ts:704-1013`, all writes, all need
`orchestration:operate`; every command carries client-generated `commandId` and most `createdAt`
ISO string; ids are just non-empty branded strings — use UUIDs):

```
project.create        {commandId, projectId, title, workspaceRoot, createWorkspaceRootIfMissing?, defaultModelSelection?, createdAt}
project.meta.update   {commandId, projectId, title?, workspaceRoot?, defaultModelSelection?, defaultThreadEnvMode?, faviconPath?, scripts?}
project.delete        {commandId, projectId, force?}
thread.create         {commandId, threadId, projectId, title, modelSelection, runtimeMode, interactionMode?, branch|null, worktreePath|null, createdAt}
thread.delete / thread.archive / thread.unarchive / thread.settle / thread.unpin   {commandId, threadId}
thread.unsettle       {..., reason:"user"}      thread.snooze {..., snoozedUntil}   thread.unsnooze {..., reason:"user"}
thread.pin {..., orderKey?}   thread.pin.reorder {..., orderKey}
thread.meta.update    {commandId, threadId, title? | regenerateTitle:true, modelSelection?, branch?, expectedBranch?, worktreePath?, linkedPullRequest?}
thread.runtime-mode.set      {commandId, threadId, runtimeMode, createdAt}
thread.interaction-mode.set  {commandId, threadId, interactionMode, createdAt}
thread.turn.start     {commandId, threadId, message:{messageId, role:"user", text, attachments:[]},
                       modelSelection?, titleSeed?, runtimeMode, interactionMode,
                       bootstrap?:{createThread?:{projectId,title,modelSelection,runtimeMode,interactionMode,branch,worktreePath,createdAt},
                                   prepareWorktree?:{projectCwd, baseBranch, branch?, startFromOrigin?}, runSetupScript?},
                       sourceProposedPlan?, createdAt}          ← "send message"; bootstrap.createThread lets you create+send in one call
thread.turn.interrupt        {commandId, threadId, turnId?, createdAt}
thread.approval.respond      {commandId, threadId, requestId, decision, createdAt}   decision ∈ ProviderApprovalDecision (L140)
thread.user-input.respond    {commandId, threadId, requestId, answers: Record<string,unknown>, createdAt}
thread.checkpoint.revert     {commandId, threadId, turnCount, createdAt}
thread.session.stop          {commandId, threadId, createdAt, onlyIfSettled?}
```
Enums: `RuntimeMode = "approval-required"|"auto-accept-edits"|"auto"|"full-access"` (default
`full-access`, L120-128); `ProviderInteractionMode = "default"|"plan"`; `ModelSelection` wire =
`{instanceId: ProviderInstanceId, model: string, options?}` (legacy `provider` key accepted, L55-98).
Limits: text ≤ 120k chars, ≤ 8 attachments (L156-159). Attachments in the WS variant may be
`UploadChatAttachment` (needs `attachments.createUploadUrl` first); HTTP dispatch takes only
already-stored `ChatAttachment`.

**Read models** (`orchestration.ts`):
- `OrchestrationProject` L285: `{id, title, workspaceRoot, repositoryIdentity?, defaultModelSelection, defaultThreadEnvMode?, faviconPath?, scripts[], createdAt, updatedAt, deletedAt}`
- `OrchestrationThreadShell` L513 (list row): `{id, projectId, title, modelSelection, runtimeMode, interactionMode, branch, worktreePath, linkedPullRequest?, latestTurn, createdAt, updatedAt, archivedAt, settledOverride, settledAt, unsettledAt?, snoozedUntil?, pinnedAt?, session, latestUserMessageAt, hasPendingApprovals, hasPendingUserInput, hasActionableProposedPlan, backgroundLiveness?, planProgress?}`
- `OrchestrationThread` L437 (detail) = shell fields + `messages[] {id, role, text, attachments?, turnId, streaming, createdAt, updatedAt}`, `proposedPlans[]`, `activities[]`, `checkpoints[]`.
- `OrchestrationSession` L350: `{threadId, status, providerName, providerInstanceId?, runtimeMode, activeTurnId, lastError, updatedAt}`; `status ∈ idle|starting|running|ready|interrupted|stopped|error` (L339).
- `OrchestrationLatestTurn` L412: `{turnId, state: running|interrupted|completed|error, requestedAt, startedAt, completedAt, assistantMessageId, sourceProposedPlan?}`.

### 3.2 Everything else in `WsRpcGroup` (name → scope; S = stream)

Server: `server.probe` R, `server.getConfig` R (providers, models, env), `server.refreshProviders` W,
`server.updateProvider` W, `server.updateServer` W, `server.updateServerWithProgress` W S,
`server.upsertKeybinding` W, `server.removeKeybinding` W, `server.getSettings` R,
`server.updateSettings` W, `server.discoverSourceControl` R, `server.getTraceDiagnostics` R,
`server.getProcessDiagnostics` R, `server.getProcessResourceHistory` R,
`server.getResourceTelemetryHistory` R, `server.retryResourceTelemetry` W, `server.getUsageSummary` R,
`server.signalProcess` W, `server.reportClientActivity` R, `server.reportHostPowerState` W,
`server.getBackgroundPolicy` R. Cloud: `cloud.getRelayClientStatus` relay:read,
`cloud.installRelayClient` relay:write S.
Files: `projects.listEntries` R, `projects.readFile` R, `projects.searchContents` R,
`projects.searchEntries` R, `projects.writeFile` W, `filesystem.browse` R, `shell.openInEditor` W,
`assets.createUrl` R, `attachments.createUploadUrl` W, `attachments.delete` W, `provider.uploadFeedback` W.
VCS/Git: `vcs.pull` W S, `vcs.refreshStatus` R, `vcs.listRefs` R, `vcs.createWorktree` W,
`vcs.removeWorktree` W, `vcs.createRef` W, `vcs.switchRef` W, `vcs.init` W, `git.runStackedAction` W S,
`git.resolvePullRequest` W, `git.preparePullRequestThread` W, `subscribeVcsStatus` R S
(payload `VcsStatusInput`; git status per project/worktree).
Review: `review.getDiffPreview` RV, `review.getDiffFileContents` RV.
Pull requests: `pullRequests.{list,listStats,detail,activity,threadComments,diffFileContents,invalidate,reviewerCandidates}` R;
`pullRequests.{runAction,update,comment,updateComment,submitReview,replyToThread,setThreadResolution,setReaction,requestReviewers}` W.
Source control: `sourceControl.lookupRepository` R, `sourceControl.cloneRepository` W S, `sourceControl.publishRepository` W.
Terminal (T): `terminal.{open,attach(S),write,resize,clear,restart,close}`, `subscribeTerminalEvents` S, `subscribeTerminalMetadata` S.
Preview: `preview.{open,navigate,resize,refresh,close,reportStatus}` W, `preview.list` R,
`previewAutomation.{connect(S),respond,focusHost}` W, `subscribePreviewEvents` R S, `subscribeDiscoveredLocalServers` R S.
Server streams: `subscribeServerConfig` R S (payload `{environmentThemes?}`), `subscribeServerLifecycle` R S,
`subscribeAuthAccess` access:read S, `subscribeBackgroundPolicy` R S, `subscribeResourceTelemetry` R S.

Schemas for each are in the sibling contract files: `git.ts`, `project.ts`, `terminal.ts`,
`preview.ts`, `pullRequest.ts`, `server.ts`, `settings.ts`, `review.ts`, `sourceControl.ts`,
`filesystem.ts`, `assets.ts`, `usage.ts`, `resourceTelemetry.ts`, `background.ts`.

---

## 4. Events / subscriptions / "wait until idle"

- Subscriptions are ordinary RPCs with `stream: true` over the same `/ws`. Effect RPC multiplexes
  requests + streams on one socket.
- `orchestration.subscribeShell` emits (`orchestration.ts:576-611`):
  `{kind:"snapshot", snapshot: OrchestrationShellSnapshot}` first, then `{kind:"synchronized"}`
  (if `requestCompletionMarker`), then deltas `project-upserted | project-removed | thread-upserted |
  thread-removed` each with `sequence`. Reconnect with `afterSequence` to resume.
- `orchestration.subscribeThread` emits (`L1583-1596`): `{kind:"snapshot", snapshot:
  OrchestrationThreadDetailSnapshot}` → `{kind:"synchronized"}` → `{kind:"event", event:
  OrchestrationEvent}`. `OrchestrationEvent` (L1434-1582) is a tagged union on `type`, including:
  `thread.created, thread.deleted, thread.archived, thread.meta-updated, thread.message-sent,
  thread.turn-start-requested, thread.turn-interrupt-requested, thread.session-set,
  thread.message.assistant.delta, thread.message.assistant.complete, thread.activity-appended,
  thread.approval-response-requested, thread.user-input-response-requested,
  thread.proposed-plan-upserted, thread.turn-diff-completed, thread.reverted, thread.settled,
  thread.unsettled, thread.snoozed, thread.pinned, thread.runtime-mode-set,
  thread.interaction-mode-set, thread.session-stop-requested, project.created,
  project.meta-updated, project.deleted`. Streaming assistant text = the
  `thread.message.assistant.delta {messageId, delta, turnId?}` events; server coalesces them
  (`apps/server/src/orchestration/ThreadLiveEventCoalescer.ts`).
- No dedicated "wait for idle" RPC. Derive it from state (this is what the UI does,
  `packages/client-runtime/src/state/threadSettled.ts`):
  - **turn finished** ⇔ `thread.latestTurn.state ∈ {completed, interrupted, error}` and
    `latestTurn.turnId` equals the turn started by your message (watch for
    `thread.turn-start-requested` / `thread.session-set` after dispatch to learn `turnId`), or
    `session.status ∈ {idle, ready, stopped, error}` with `activeTurnId === null`.
  - **needs you**: `hasPendingApprovals` / `hasPendingUserInput` on the shell row, or events
    `thread.approval-response-requested` / `thread.user-input-response-requested`.
  - `settledAt`/`settledOverride` is the user-facing "settled" flag (auto-settle reactor
    `ThreadSettlementReactor.ts`), not a reliable idle signal.
  - HTTP-only alternative: poll `GET /api/orchestration/threads/:id?turnLimit=1`.
- Dispatch is async: `DispatchResult.sequence` is the event-log sequence the command was
  accepted at; you can `subscribeThread({threadId, afterSequence: sequence})` right after.

---

## 5. Existing programmatic / headless entry points

- **`t3` CLI subcommands** (`apps/server/src/bin.ts:50-75`): `t3 [start] | serve | pair | auth
  {pairing {create,list,revoke}, session {issue,list,revoke}} | project {add,remove,rename} |
  service {install,update,uninstall,status} | connect {...} | theme | triage`. `t3 auth ... --json`
  and `--token-only` exist. `t3 project add` is a live-server-aware HTTP client (§2.5-B) — the closest
  thing to what you want; there is **no** `t3 thread ...` or message-sending command.
- **HTTP API** (§1.2) — `HttpApiClient.make(EnvironmentHttpApi, {baseUrl})` from
  `@t3tools/contracts` gives a typed client for free (`cli/project.ts:228-231`).
- **`@t3tools/client-runtime`** (`packages/client-runtime`, private) — the shared Effect client used
  by web/desktop/mobile: `rpc/session.ts` (WS session factory), `rpc/client.ts` (`request`,
  `subscribe`, `runStream`), `authorization/remote.ts` (token exchange, ws ticket, URL build),
  `state/*` (reducers for shell/thread streams, `threadSettled.ts`). Heavily tied to
  `@effect/atom-react`; vendor selectively.
- **MCP server** at `/mcp` (`apps/server/src/mcp/McpHttpServer.ts:222`) — **preview-browser tools
  only** (`preview_open, preview_navigate, preview_click, preview_type, preview_press,
  preview_scroll, preview_resize, preview_snapshot, preview_evaluate, preview_wait_for,
  preview_status, preview_set_appearance, preview_recording_start/stop`). Bearer tokens are
  per-provider-session, issued in-memory by `McpSessionRegistry.ts` and injected into the agent's
  MCP config. No thread/project tools. Not reusable for your goal.
- No `packages/sdk`, no `apps/cli`, no documented public protocol beyond
  `docs/internals/{environment-auth,remote,connection-runtime}.md`. Protocol is "whatever
  `WsRpcGroup` + `EnvironmentHttpApi` say" and changes per release (see `subscribeServerConfig`
  compat note `rpc.ts:985-1000`); pin your CLI to the contracts of the installed server version
  and check `server.probe` / `/.well-known/t3/environment`.

---

## 6. Shared types to depend on / vendor

| Package | Name | Published? | Contents |
|---|---|---|---|
| `packages/contracts` | `@t3tools/contracts` | **No** (private; exports `.`, `./settings`, `./relay`) | All Effect `Schema`s + `WsRpcGroup` + `EnvironmentHttpApi`. Single dep: `effect@4.0.0-beta.103`. ~50 files; `rpc.ts`, `orchestration.ts`, `auth.ts`, `environmentHttp.ts`, `baseSchemas.ts`, `model.ts`, `provider*.ts` are the ones you need. |
| `packages/shared` | `@t3tools/shared` | No | utils (`oauthScope`, `qrCode`, `relayClient`, …); contracts don't depend on it. |
| `packages/client-runtime` | `@t3tools/client-runtime` | No | client session/state layer (see §5). |
| npm `t3` (`apps/server`) | `t3` | Yes | ships only `dist/bin.mjs` + `service-launcher.mjs` bundles (`vp pack`, `apps/server/package.json` `files:["dist"]`) — **no type exports**. |

Recommendation: vendor `packages/contracts/src/{baseSchemas,orchestration,auth,environmentHttp,
rpc,model,provider,providerInstance,providerRuntime,server,settings,environment,project,git,vcs,
filesystem,assets,...}.ts` (rpc.ts imports nearly all of them — take the whole dir; it's
self-contained on `effect`) into your CLI at the matching tag, pin `effect@4.0.0-beta.103`, and
use `HttpApiClient.make(EnvironmentHttpApi)` + `RpcClient.make(WsRpcGroup)` exactly as
`cli/project.ts` and `client-runtime/src/rpc/session.ts` do. If you'd rather not take Effect, the
HTTP endpoints are plain JSON/form and a hand-written `fetch` + `ws` client works; only the WS RPC
framing needs Effect's `RpcSerialization.layerJson` format (or replicate it: JSON-encoded
`RpcMessage` envelopes `{_tag:"Request", id, tag, payload, headers}` /
`{_tag:"Exit"|"Chunk", requestId, ...}` — see `effect/unstable/rpc/RpcMessage`).

---

## 7. Minimal happy path (HTTP only)

```
1. state = JSON.parse(read ~/.t3/userdata/server-runtime.json)   # or hardcode http://127.0.0.1:3773
2. GET {origin}/.well-known/t3/environment                      # sanity + auth descriptor
3. TOKEN = `t3 auth session issue --token-only --label my-cli`  # once; store it (30d)
   (or: CRED=`t3 auth pairing create --token-only`; POST /oauth/token form → access_token)
4. GET  /api/orchestration/shell        -H "Authorization: Bearer $TOKEN"   # projects + thread rows
5. GET  /api/orchestration/threads/<id>?turnLimit=5                          # messages
6. POST /api/orchestration/dispatch  (JSON ClientOrchestrationCommand)
     project.create | thread.create | thread.turn.start (message text; optional bootstrap.createThread)
   → {sequence}
7. Live: POST /api/auth/websocket-ticket → ws://host:port/ws?wsTicket=…  (or just send the Bearer
   header on the upgrade) → RPC `orchestration.subscribeThread {threadId, afterSequence}` and
   watch `thread.message.assistant.delta` / `latestTurn.state`.
```
Scopes needed: steps 4-5,7 `orchestration:read`; step 6 `orchestration:operate`. Model selection
for `thread.create`/`thread.turn.start`: take `project.defaultModelSelection` from the shell
snapshot, or list providers via WS `server.getConfig`.
