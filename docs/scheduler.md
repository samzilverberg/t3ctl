# Scheduler

`t3ctl schedule` is a thin client of **T3 Code's built-in scheduler** (0.1+). Tasks live in the app's own
database, are fired by the server (with or without any client around), and are the same objects the desktop UI
and the MCP `schedule_task` / `list_scheduled_tasks` / `update_scheduled_task` / `delete_scheduled_task` /
`run_scheduled_task_now` tools manage. t3ctl keeps no job file and no launchd ticker of its own, so there is one
source of truth and nothing can double-fire.

```
t3ctl schedule add --at 09:00 --days mon-fri -p mono -m opus -e high -t "Morning triage" "Triage open issues…"
t3ctl schedule add --every 2h --thread <ref> "Check the board and report"      # message into one thread per run
t3ctl schedule add --cron "0 8 * * 4" -p mono "Thursday: …"                   # cron that T3 can express
t3ctl schedule add --webhook -p mono "Handle {{body.action}} on {{body.repository.full_name}}"
t3ctl schedule                                   # list (id, on/off, schedule, target, model, next, last run)
t3ctl schedule show <ref> | update <ref> [flags] [prompt] | enable|disable <ref> | run <ref> | remove <ref>
```

`<ref>` is a task id, id prefix or exact title.

## Schedules T3 Code supports

| flag | server schedule | notes |
|---|---|---|
| `--every <dur>` | `interval` | ≥ 1 minute (`30m`, `2h`, `1d`) |
| `--at HH:MM [--days spec]` | `fixed_time` | local wall-clock time **of the machine running the server**; `--days` = `mon-fri`, `weekdays`, `weekends`, `mon,wed,fri`, `0-6` |
| `--cron <expr>` | translated | only `*/N * * * *`, `0 */N * * *`, `M H * * D`, `@hourly`, `@daily`, `@weekly`; anything else exits with `cron_not_expressible` |
| `--webhook` | `webhook` | runs on each request to the task's URL (shown after `add`; needs T3 Connect remote access). Signatures, filters and dedupe are configurable in the app, not from t3ctl. |

There are **no one-shots** ("in 2h", "tomorrow 09:00"): the server has no deferred single start. Start the
thread yourself when the time comes, or use `--at HH:MM` and `remove` the task after it ran. There is no
timezone pin either; fixed times follow the server's local zone.

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

Earlier t3ctl versions kept jobs in `~/.config/t3ctl/schedule.json` and fired them from a launchd agent
(`dev.t3ctl.scheduler`) every minute. That mechanism no longer works against T3 Code 0.1 and is removed.

```
t3ctl schedule migrate          # dry run: what would be created, what cannot be
t3ctl schedule migrate --apply  # create the tasks, remove the launchd agent, rename the file to schedule.legacy.json
```

Recurring cron jobs that T3 can express are created as tasks (same project/thread, model, effort); one-shots and
non-expressible crons are listed with the reason and left for you. `schedule tick` stays as a silent no-op so the
old agent does not log failures until `migrate --apply` removes it.
