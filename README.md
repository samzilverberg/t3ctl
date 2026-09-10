# t3ctl

Local CLI for controlling an **already-running** T3 Code app. Never starts a server.
TypeScript, Node ≥22, pnpm, two runtime deps (`commander`, `ws`). Token in macOS Keychain,
config in `~/.config/t3ctl/config.json`.

Status: v0.0.3 — reads, thread management, approvals, projects. Verified against T3 Code 0.0.38 on 2026-09-06.

```
t3ctl env                                  # which server we target (no auth)
t3ctl auth pair [--operate] | status | forget
t3ctl models [-a]                          # models per provider + allowed effort / context-window values
t3ctl projects [list|show <ref>]
t3ctl projects add <path> [-t title] [-m model] [-e effort] [--create-dir]
t3ctl projects remove <ref> [--force]
t3ctl threads [list] [-p project] [-s status] [-a] [-n N]
t3ctl threads -i <id,id,…>                                   # status report for known ids (Obsidian sync)
t3ctl threads show <ref> [-t turns]
t3ctl threads search <query>
t3ctl threads watch <ref> [--timeout s]                      # raw NDJSON event stream
t3ctl threads wait <ref> [--timeout s] [--require-turn]      # exit 0 idle · 2 needs-human · 3 error · 4 timeout
t3ctl threads new  -p <project> [-m model] [-e effort] [--context-window 1m] [--fast]
                   [-t title] [--env worktree|local] [--base br] [--branch br]
                   [--runtime-mode …] [--interaction-mode default|plan] [--no-setup-script]
                   [--wait] [--stdin] "<prompt>"
t3ctl threads send <ref> [-m model] [-e effort] [--wait] "<prompt>"
t3ctl threads pending <ref>                                  # open approval / user-input requests
t3ctl threads approve <ref> [-d accept|acceptForSession|acceptAlways|decline] [-r requestId]
t3ctl threads respond <ref> -a <questionId>=<answer> … | --json '{…}'
t3ctl threads snooze <ref> -u <when> | unsnooze <ref>            # sidebar visibility only
t3ctl threads new … --draft [--snooze <when>]                    # create without starting a turn
t3ctl threads settle|unsettle <ref>
t3ctl threads interrupt|archive|unarchive <ref>
```

`<when>` = ISO, `30m`/`2h`/`3d`/`1w`, `HH:MM` (today, else tomorrow), or `"tomorrow [HH:MM]"` (default 09:00).

Verified live: everything above except `threads respond` (user-input questions), whose payload mirrors the
web client's `derivePendingUserInputs` but has not yet been exercised against a real prompt.

Global: `--origin <url>`, `-f json|table`, `--no-auto-pair`. Output is JSON when stdout is not a TTY or
`T3CTL_AGENT=1`. `T3CTL_TOKEN` overrides the Keychain. `<ref>` = id, id prefix, or exact title (projects
also accept workspaceRoot). Model refs accept slug or alias (`sonnet`, `opus`, `fable`) or `instanceId/slug`.

### Install for humans and agents

```sh
pnpm install            # also builds dist/ (prepare script)
pnpm link --global      # exposes `t3ctl` from $PNPM_HOME (~/Library/pnpm), already on PATH in fish
```

Standard pnpm global link: the package's `bin` entry points at `dist/index.js` (shebang `#!/usr/bin/env node`,
resolved through the mise `node` shim). Every agent that shells out (Claude Code, T3 Code sessions, cron) sees
`t3ctl` with no wrapper scripts. After changing sources run `pnpm build` (the link follows the repo, so the new
build is live immediately). Dev loop without building: `pnpm dev <args>`.

### Config defaults

`~/.config/t3ctl/config.json` may carry a `defaults` block used by `threads new` when flags are omitted:

```json
{ "defaults": { "runtimeMode": "auto", "interactionMode": "default", "model": "opus", "effort": "high", "env": "worktree" } }
```

Built-in runtime mode default is `auto` (T3 Code's own default is `full-access`). Model resolution order for
`threads new`: `-m` → `defaults.model` → project default → server default. Your config currently sets
`defaults.model: "opus"` (= Opus 4.8).

### Snooze is not scheduling

T3's `thread.snooze` only hides the thread from the sidebar until `snoozedUntil` (the decider comment: "snooze
only affects visibility, never the agent"). A running turn keeps running; a draft stays a draft. The server
rejects snoozing a thread with a pending approval/user-input or a still-queued turn, so `new --snooze` waits for
the turn to be adopted before snoozing. There is no server-side deferred start; to run something later use the
planner (Obsidian scheduled task → `t3ctl threads new` when due) or a cron/launchd job.

### Model references

`-m` accepts, in this order: a t3ctl alias, an exact slug or server alias, or a fuzzy form where spaces/dots
become dashes and `claude-` is implied (`"Fable 5.0"` → `claude-fable-5`, `"opus 4.7"` → `claude-opus-4-7`).
Prefix with `instanceId/` to pin a provider. Built-in aliases deliberately differ from the server's own
(`opus`/`sonnet` on the server mean the 5.x line):

| alias | resolves to |
|---|---|
| `opus` | `claude-opus-4-8` |
| `fable` | `claude-fable-5-1` |
| `sonnet` | `claude-sonnet-4-6` |

Override or extend via `"modelAliases": { "opus": "claude-opus-5", "cheap": "haiku" }` in config.json.
`t3ctl models` lists legacy models too (`--no-legacy` hides them, `-a` adds disabled providers) and marks t3ctl aliases with `*`.

### Token lifetime and re-pairing

- The Keychain holds a **30-day** bearer session (server TTL, not configurable client-side). Its scopes and
  expiry are mirrored in `config.json`.
- Re-pairing is **automatic and non-interactive**: when the token is missing, within 60 s of expiry, lacks a
  scope the command needs (e.g. first write → `orchestration:operate`), or the server answers 401 (revoked
  in the UI), t3ctl mints a fresh pairing credential via the installed `t3 auth pairing create`, exchanges it,
  and overwrites the Keychain item. A one-line notice goes to stderr. `--no-auto-pair` turns this into an error.
- Read-only by default. The first `threads new/send/interrupt/archive` upgrades the session to
  `orchestration:read orchestration:operate`; the upgraded session is kept afterwards.
- Each pairing shows up as a connection in T3 Code → Settings → Connections; revoke stale ones there.

### Thread creation defaults

- **Model**: `--model` → project `defaultModelSelection` → server `textGenerationModelSelection`.
  `--effort` / `--context-window` / `--fast` are validated against the model's option descriptors from
  `server.getConfig` (`t3ctl models` prints them; `*` marks defaults).
- **Env**: `--env` → server `defaultThreadEnvMode` (yours: `worktree`). Worktree mode needs the project root to
  be a git checkout; base branch = `--base` or the checkout's current branch; worktree branch = `--branch` or
  `t3code/<hex>` like the desktop; `newWorktreesStartFromOrigin` is honoured; setup script runs unless
  `--no-setup-script`. Non-git roots fall back to `local`.
- **Modes**: `--runtime-mode` (default `auto`, or `defaults.runtimeMode`) and `--interaction-mode default|plan`.

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

### Write surface

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

### Pending approvals

Not a first-class field. Like the web client (`apps/web/src/session-logic.ts`), t3ctl derives them from
`thread.activities`: an `approval.requested` / `user-input.requested` activity whose `payload.requestId` has no
later `*.resolved` activity is open. `threads wait` reports `needs-human` from the shell flags
`hasPendingApprovals` / `hasPendingUserInput` (polled), then `threads pending` lists the request ids.

## Roadmap

1. Exercise `threads respond` against a real user-input prompt.
2. Multi-environment Keychain entries (`--origin https://…` already works for one remote server at a time).
3. `threads diff <ref>` via `orchestration.getFullThreadDiff`.

## Obsidian integration

Implemented as conventions, not code: `_planner/conventions.md` in the vault has a "T3 Code delegation" section
and `skills/t3ctl/SKILL.md` (symlinked to `~/.claude/skills/t3ctl`, so every Claude session sees it) tells agents
how to use it. Summary:

- **Task ↔ thread pairing**: store the thread id on the task note as frontmatter, e.g.
  `t3-thread: <uuid>`, `t3-project: mono`, `t3-status: running|idle|needs-human|done`, `t3-updated: <iso>`.
  `threads new` prints the id (JSON `threadId`); the agent writes it with the Obsidian CLI. Reverse lookup
  is `t3ctl threads search "<note title>"` or by putting the note path in the first prompt line.
- **Model / effort choice**: default from frontmatter (`t3-model: sonnet`, `t3-effort: low`) with a per-vault
  policy in the skill: small chores → `sonnet@low`, code changes → `opus@high`, research/design → `fable@xhigh`.
  Absent frontmatter → project default.
- **Progress**: `t3ctl threads show <id> -t 1` for the latest assistant message; `t3ctl threads wait <id>`
  (exit code) for blocking flows; `-s needs-approval` listing for a "needs me" view.
- **Skill exposure**: symlink `skills/t3ctl` into `~/.claude/skills/t3ctl` so every Claude session (user scope)
  discovers it; T3 Code sessions see it the same way via the home-directory Claude config.
