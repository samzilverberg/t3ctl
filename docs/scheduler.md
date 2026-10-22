# Scheduler

`t3ctl schedule` is a thin client of **T3 Code's built-in scheduler** (0.1+) for everything recurring. Tasks live
in the app's own database, are fired by the server (with or without any client around), and are the same objects
the desktop UI and the MCP `schedule_task` / `list_scheduled_tasks` / `update_scheduled_task` /
`delete_scheduled_task` / `run_scheduled_task_now` tools manage.

The one gap is **one-shots**: the server cannot fire once at a date (upstream asks: discussions
[#6748](https://github.com/pingdotgg/t3code/discussions/6748),
[#20863](https://github.com/pingdotgg/t3code/discussions/20863)). For those, and only those, t3ctl keeps a small
client-side job file plus a launchd ticker (`--once`, below). Recurring work never goes through the ticker, so the
two cannot double-fire.

```
t3ctl schedule add --at 09:00 --days mon-fri -p mono -m opus -e high -t "Morning triage" "Triage open issues…"
t3ctl schedule add --every 2h --thread <ref> "Check the board and report"      # message into one thread per run
t3ctl schedule add --cron "0 8 * * 4" -p mono "Thursday: …"                   # cron that T3 can express
t3ctl schedule add --webhook -p mono "Handle {{body.action}} on {{body.repository.full_name}}"
t3ctl schedule add --once "tomorrow 09:00" --thread <ref> "Check whether the deploy settled"   # one-shot (t3ctl ticker)
t3ctl schedule add --once 2h --grace 15m -p mono "Re-run the flaky suite"
t3ctl schedule [-a]                              # server tasks + pending one-shots (-a: fired/missed too), ticker state
t3ctl schedule show <ref> | update <ref> [flags] [prompt] | enable|disable <ref> | run <ref> | remove <ref>
t3ctl schedule tick | install | uninstall        # the one-shot ticker (installed automatically by the first --once)
```

`<ref>` is a task id, id prefix or exact title; one-shots are `once:<hex>` (the hex prefix alone works too).

## Schedules T3 Code supports

| flag | server schedule | notes |
|---|---|---|
| `--every <dur>` | `interval` | ≥ 1 minute (`30m`, `2h`, `1d`) |
| `--at HH:MM [--days spec]` | `fixed_time` | local wall-clock time **of the machine running the server**; `--days` = `mon-fri`, `weekdays`, `weekends`, `mon,wed,fri`, `0-6` |
| `--cron <expr>` | translated | only `*/N * * * *`, `0 */N * * *`, `M H * * D`, `@hourly`, `@daily`, `@weekly`; anything else exits with `cron_not_expressible` |
| `--webhook` | `webhook` | runs on each request to the task's URL (shown after `add`; needs T3 Connect remote access). Signatures, filters and dedupe are configurable in the app, not from t3ctl. |

There is no timezone pin; fixed times follow the server's local zone. There are no server one-shots either, which
is what `--once` is for.

## One-shots: `--once <when>` (client-side)

`<when>` is `30m` / `2h` / `3d`, `17:30` (today if still ahead, else tomorrow), `"tomorrow [HH:MM]"` (default
09:00) or an ISO timestamp, and must be in the future. The job is stored in `~/.config/t3ctl/once.json`; a
LaunchAgent (`dev.t3ctl.scheduler`, every minute while you are logged in) runs `t3ctl schedule tick`, which fires
whatever is due. The first `--once` installs the agent; `schedule add` prints `tickerInstalled` and `schedule`
shows `ticker.installed`. `schedule uninstall` removes it (pending one-shots then never fire).

Firing: `--thread` → the prompt is sent into that thread, **queued** after the active run if it is busy (not
dropped); `-p` → a new thread is launched exactly like `threads new` (model, effort, env, modes as stored).
A fire more than `--grace` late (default 60m; the Mac was asleep, the app was closed) is recorded as `missed`
and never replayed. Each job fires at most once; `schedule run <once-id>` fires it now, `update --once <when>`
moves it, `remove` cancels it. `schedule -a` lists fired/missed/failed ones (the last 50 are kept). Log:
`~/.config/t3ctl/scheduler.log`.

Limits: the Mac must be awake and logged in, and the T3 Code app running, at fire time (same as the server's
own tasks). Only one machine should hold the job file.

## What a run does

- **New thread per run** (`-p <project>`): the server launches a thread with the stored model, modes and
  workspace strategy (`--env worktree` → a fresh worktree off `--base`/the checkout's current branch, setup
  script included; `--env local` → the project root). The prompt is the first message.
- **Bound to a thread** (`--thread <ref>`): the prompt is queued into that thread (`queue` delivery), following
  the thread's current provider/model.
- A task that is still running when its next time comes is skipped for that occurrence (server rule). The
  server also skips occurrences while it was not running; nothing is replayed.
- `lastRunStatus` / `lastRunError` / `runCount` / `nextRunAt` are server fields; `schedule` shows them.

## Migrating from the t3ctl ≤ 0.4 scheduler

Earlier t3ctl versions kept every job (cron and one-shot) in `~/.config/t3ctl/schedule.json` and fired them from
the same launchd agent. That store no longer works against T3 Code 0.1.

```
t3ctl schedule migrate                  # dry run: what would be created, what cannot be
t3ctl schedule migrate --apply          # create them, rename the file to schedule.legacy.json, fix the ticker
t3ctl schedule migrate --from <file>    # read another legacy file (default: schedule.json, else schedule.legacy.json)
```

Recurring cron jobs that T3 can express become server tasks (same project/thread, model, effort), skipped when an
identical task already exists; one-shots still in the future become `--once` jobs; past one-shots and
non-expressible crons are listed with the reason. The ticker is kept exactly when a pending one-shot exists.
