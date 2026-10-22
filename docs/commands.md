# Command reference

Every command prints JSON when stdout is not a TTY or `T3CTL_AGENT=1`, a table otherwise (`-f json|table` forces).
`<ref>` is an id, an id prefix, or an exact title (projects also accept their workspace root).

```
t3ctl env                                  # which server we target (no auth); JSON adds isDesktopBackend, degraded, supported
t3ctl servers                              # every running T3 server on 127.0.0.1:3773-3780 (unsupported ones marked)
t3ctl auth pair [--operate] | status | forget
t3ctl models [-a] [--no-legacy]            # models per provider + allowed effort / context-window values
t3ctl projects [list|show <ref>]
t3ctl projects add <path> [-t title] [-m model] [-e effort] [--create-dir]
t3ctl projects remove <ref> [--force]

t3ctl threads [list] [-p project] [-s status] [-a] [-n N]
t3ctl threads -i <id,id,…>                                   # status report for known ids
t3ctl threads show <ref> [-n messages]
t3ctl threads search <query>
t3ctl threads watch <ref> [--timeout s]                      # raw NDJSON event stream
t3ctl threads wait <ref> [--timeout s] [--require-run]       # exit 0 idle · 2 needs-human · 3 error · 4 timeout
t3ctl threads new  -p <project> [-m model] [-e effort] [--context-window 1m] [--fast]
                   [-t title] [--env worktree|local] [--base br] [--branch br]
                   [--runtime-mode …] [--interaction-mode default|plan]
                   [--wait] "<prompt>" | -                   # - reads the prompt from stdin
t3ctl threads new -p <project> [shared flags] --batch <file|->   # 2-5 related threads in one call
t3ctl threads new … --draft [--snooze <when>]                # create without starting a turn
t3ctl threads send <ref> [-m model] [-e effort] [--queue|--steer] [--wait] "<prompt>"
t3ctl threads pending <ref>                                  # open approval / user-input requests
t3ctl threads approve <ref> [-d accept|acceptForSession|acceptAlways|decline|cancel] [-r requestId]
t3ctl threads respond <ref> --answer <questionId>=<answer> … | --json '{…}'
t3ctl threads snooze <ref> -u <when> | unsnooze <ref>        # sidebar visibility only
t3ctl threads settle|unsettle <ref>
t3ctl threads interrupt|archive|unarchive <ref>

t3ctl schedule add (--every <dur> | --at HH:MM [--days spec] | --cron <expr> | --webhook | --once <when> [--grace <dur>])
                   -p <project> | --thread <ref> [-m model] [-e effort] [-t title] [--env …] [--disabled] "<prompt>"
t3ctl schedule [list] [-p project] [-a] | show <ref> | update <ref> [flags] [prompt] | enable|disable <ref> | run <ref> | remove <ref>
t3ctl schedule tick | install | uninstall                    # the one-shot ticker (launchd, every minute)
t3ctl schedule migrate [--apply] [--from <file>]             # legacy ≤0.4 jobs → T3 Code tasks + t3ctl one-shots
```

Global flags: `--origin <url>` (skip discovery; also `T3CTL_ORIGIN`), `-f json|table`, `--no-auto-pair`.
`T3CTL_TOKEN` overrides the Keychain. `T3CTL_CONFIG_DIR` relocates `~/.config/t3ctl`.

`<when>` (snooze) = ISO, `30m`/`2h`/`3d`/`1w`, `HH:MM` (today, else tomorrow), or `"tomorrow [HH:MM]"` (default 09:00).
Recurring schedules are T3 Code's (interval, fixed daily time + weekdays, webhook); `--once <when>` is a
client-side one-shot fired by the t3ctl ticker. See [scheduler.md](scheduler.md).

## Supported T3 Code versions

t3ctl 0.5+ talks orchestrator V2 only: **T3 Code ≥ 0.1.0**, orchestration protocol 2. Every command that
contacts the server first reads `/.well-known/t3/environment` and refuses with `incompatible_server` (exit 7)
when `serverVersion` < 0.1.0, when no `orchestrationProtocolVersion` is reported (the 0.0.x alphas), or when the
protocol is not 2 (a future T3 Code: update t3ctl). `t3ctl env` prints `supported` / `unsupportedReason`
instead of failing outright, but also exits 7. Constants: `MIN_SERVER_VERSION`, `SUPPORTED_PROTOCOL` in
`src/discover.ts`.

## Exit codes

`threads wait` (and `new --wait` / `send --wait`): `0` idle, `2` needs a human (approval or question), `3` run
errored, `4` timeout, `5` aborted. `threads new` refused by the duplicate / rate-limit guard: `6`. Server too old
or speaking another protocol: `7`. Everything else: `0` success, `1` error.

## Errors

Every failure prints its message on stderr. In JSON mode (`-f json`, non-TTY, `T3CTL_AGENT=1`) it is also
printed on stdout as `{"error": {"code", "message", …details}}`:

| `code` | exit | details |
|---|---|---|
| `duplicate_thread` | 6 | `project`, `duplicate {threadId,title,createdAt,secondsAgo,similarity,matchedOn}`, `retryAfterSec` |
| `rate_limited` | 6 | `project`, `limit {max,windowSec}`, `requested`, `retryAfterSec`, `recent[]` |
| `batch_partial` | 1 | `created[]` (summaries), `failedIndex`, `cause` |
| `invalid_batch` | 1 | `index` when an item is at fault |
| `thread_not_found` / `project_not_found` | 1 | `ref` (`known` titles for projects) |
| `model_unknown` / `invalid_option` | 1 | `ref` / `option`, `allowed` or `input` for times and durations (plus `index` inside a batch) |
| `no_server` | 1 | `origin` or `probed` |
| `incompatible_server` | 7 | `origin`, `serverVersion`, `orchestrationProtocolVersion`, `minServerVersion`, `supportedProtocol` |
| `thread_running` / `thread_idle` / `thread_archived` / `nothing_pending` | 1 | `threadId`, `status` (`send` without `--queue`/`--steer`, `interrupt` with no run, …) |
| `task_not_found` / `cron_not_expressible` | 1 | `ref` + `known` + `once` / `cron`, `reason` (scheduler) |
| `auth` | 1 | not paired / token rejected / pairing failed (`status` when the server answered) |
| `http_error` / `rpc_error` | 1 | `status`, `path` / `rpc` (server refused a request, e.g. 403 on a read-only token) |
| `usage` | 1 | `commanderCode` (bad or missing flag/argument, non-numeric count/seconds; commander prints usage on stderr) |
| `error` | 1 | anything unclassified |

Prompt arguments (`threads new`, `threads send`, `schedule add`) accept `-` to read stdin; `--stdin` is kept as an
alias on `new` and `send`.

## Thread status values

Derived from the V2 shell row: `running` (an active run: preparing, queued, starting, running, waiting), `idle`
(no active run; latest run completed), `needs-approval` / `needs-input` (a pending runtime request: command,
file-change, permission, … / a question; wins over running), `error` (latest run failed), `interrupted`
(interrupted or cancelled), `archived`, `new` (never ran).

## Thread creation defaults

- **Model**: `--model` → config `defaults.model` → project `defaultModelSelection` → server `textGenerationModelSelection`.
  `--effort` / `--context-window` / `--fast` are validated against the model's option descriptors from
  `server.getConfig` (`t3ctl models` prints them; `*` marks defaults).
- **Env**: `--env` → project `defaultThreadEnvMode` → server `defaultThreadEnvMode` → `worktree`. Worktree mode
  needs the project root to be a git checkout; base = `--base` or the checkout's current branch; worktree branch =
  `--branch` or `t3code/<hex>`; `newWorktreesStartFromOrigin` is honoured. The server prepares the worktree and
  runs the project setup script (`orchestration.launchThread`); there is no client-side opt-out any more. Non-git
  roots fall back to `local` (the project root).
- **Modes**: `--runtime-mode` (default `auto`, or `defaults.runtimeMode`) and `--interaction-mode default|plan`.

## Duplicate and rate-limit guard

Agents occasionally run the same `threads new` twice within seconds (a double-submitted message, a retry) and
end up with two threads doing the same paid work. Before creating, `threads new` checks the threads the server
already has in the target project and refuses with exit `6` when:

- **`duplicate_thread`**: a thread created in the last `windowSec` (60) has a first prompt at least `similarity`
  (0.8) alike (Dice over character trigrams, case and punctuation ignored). Drafts compare titles instead.
- **`rate_limited`**: `rateMax` (5) threads were already created in the project in the last `rateWindowSec` (60),
  by anyone (t3ctl, the app, the scheduler).

Distinct tasks written from one template ("Review PR #123" / "Review PR #124") also count as alike. That is the
accepted cost of a cheap text check: create such threads together with `--batch`, or wait.

```json
{"error": {"code": "duplicate_thread", "message": "a very similar thread c910869f \"Fix CJS build\" was created 11s ago …",
  "project": "dev", "retryAfterSec": 49,
  "duplicate": {"threadId": "c910869f-…", "title": "Fix CJS build", "createdAt": "…", "secondsAgo": 11, "similarity": 0.91, "matchedOn": "prompt"}}}
{"error": {"code": "rate_limited", "message": "5 thread(s) were already created in project dev in the last 60s …",
  "project": "dev", "limit": {"max": 5, "windowSec": 60}, "requested": 1, "retryAfterSec": 48,
  "recent": [{"threadId": "…", "title": "…", "createdAt": "…", "secondsAgo": 12}]}}
```

There is no per-call override: check the reported thread first (usually it is this task, already started), then
use `--batch` for several related threads or wait `retryAfterSec`. It is best effort, not a lock: two calls
racing within the same second can both pass. The happy path costs nothing extra (the shell snapshot is fetched anyway; only threads inside the window
get their first prompt fetched). The scheduler does not use the guard.

Tune or disable in `~/.config/t3ctl/config.json` (`windowSec: 0` turns the duplicate check off, `rateMax: 0` the
rate limit):

```json
{ "guard": { "windowSec": 60, "similarity": 0.8, "rateMax": 5, "rateWindowSec": 60 } }
```

## Several threads at once: `--batch`

When you really want 2-5 related threads, create them in one call instead of looping over `threads new`:

```sh
t3ctl threads new -p myrepo -m opus -e high --batch - <<'JSON'
[
  "Fix the flaky login test",
  {"prompt": "Add retries to the upload client", "title": "Upload retries", "effort": "medium"},
  {"prompt": "Write docs for the retry policy", "model": "sonnet", "branch": "docs/retries"}
]
JSON
```

`--batch <file>` (`-` = stdin) takes a JSON array of prompt strings or objects with `prompt` plus optional `title`,
`model`, `effort`, `branch`. Every other flag (`-p`, `-m`, `-e`, `--env`, `--runtime-mode`, `--draft`, `--snooze`,
…) applies to all items. Not allowed with a prompt argument, `--stdin`, `-t`, `--branch` or `--wait` (wait per id
with `threads wait`). 2 to 5 items: a single thread is a plain `threads new`, so a one-item batch cannot be used to
skip the duplicate check. The check against recent threads is skipped (the items are meant to be related), but
items that repeat each other verbatim are rejected, and the rate limit still counts the whole batch. Every item's
model and effort are validated before anything is created. Threads are then created in order; if one fails, the
error is `batch_partial` (exit 1) with `created` (summaries so far), `failedIndex` and `cause`. Output: an array of
the usual `threads new` summaries.

---

## Snooze is not scheduling

T3's `thread.snooze` only hides the thread from the sidebar until `snoozedUntil`. A running run keeps running; a
draft stays a draft. The server rejects snoozing a thread whose run is still being prepared, so `new --snooze`
waits for the run to start before snoozing. Deferred and recurring work belongs in `t3ctl schedule`
(`--once <when>` for a single deferred start, the rest on T3 Code's scheduler).

## Sending to a busy thread

`threads send` refuses (`thread_running`, exit 1) while the thread has an active run or a pending request. Pass
`--queue` to run the message after the active run (`queue_after_active`) or `--steer` to inject it into the
active run (`steer_active`). `-m`/`-e` change the thread's model for this and later runs; `--runtime-mode` /
`--interaction-mode` change the thread's settings before sending.
