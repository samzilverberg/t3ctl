# Scheduler

`t3ctl schedule` is a thin client of **T3 Code's built-in scheduler** (0.1+). Tasks live in the app's own database,
are fired by the server (with or without any client around), and are the same objects the desktop UI and the MCP
`schedule_task` / `list_scheduled_tasks` / `delete_scheduled_task` / `run_scheduled_task_now` tools manage.
t3ctl keeps no job state of its own.

```
t3ctl schedule add --at 09:00 --days mon-fri -p mono -m opus -e high -t "Morning triage" "Triage open issues…"
t3ctl schedule add --every 2h --thread <ref> "Check the board and report"      # message into one thread per run
t3ctl schedule add --cron "0 8 * * 4" -p mono "Thursday: …"                   # cron that T3 can express
t3ctl schedule add --webhook -p mono "Handle {{body.action}} on {{body.repository.full_name}}"
t3ctl schedule add --once "tomorrow 09:00" --thread <ref> "Check whether the deploy settled"   # one-time (T3 Code ≥ 0.1.7)
t3ctl schedule                                   # list tasks
t3ctl schedule show <ref> | update <ref> [flags] [prompt] | enable|disable <ref> | run <ref> | remove <ref>
t3ctl schedule migrate [--apply]                 # jobs from older t3ctl schedulers → T3 Code tasks
```

`<ref>` is a task id, id prefix or exact title.

## Schedules T3 Code supports

| flag | server schedule | notes |
|---|---|---|
| `--every <dur>` | `interval` | ≥ 1 minute (`30m`, `2h`, `1d`) |
| `--at HH:MM [--days spec]` | `fixed_time` | local wall-clock time **of the machine running the server**; `--days` = `mon-fri`, `weekdays`, `weekends`, `mon,wed,fri`, `0-6` |
| `--cron <expr>` | translated | only `*/N * * * *`, `0 */N * * *`, `M H * * D`, `@hourly`, `@daily`, `@weekly`; anything else exits with `cron_not_expressible` |
| `--webhook` | `webhook` | runs on each request to the task's URL (shown after `add`; needs T3 Connect remote access). Signatures, filters and dedupe are configurable in the app, not from t3ctl. |
| `--once <when>` | `once` | **T3 Code ≥ 0.1.7** (older servers: exit 7 `incompatible_server`). `<when>` = `30m` / `2h` / `3d`, `17:30` (today if still ahead, else tomorrow), `"tomorrow [HH:MM]"` (default 09:00) or ISO; must be in the future. |

There is no timezone pin; fixed times follow the server's local zone.

## What a run does

- **New thread per run** (`-p <project>`): the server launches a thread with the stored model, modes and
  workspace strategy (`--env worktree` → a fresh worktree off `--base`/the checkout's current branch, setup
  script included; `--env local` → the project root). The prompt is the first message.
- **Bound to a thread** (`--thread <ref>`): the prompt is queued into that thread (`queue` delivery), following
  the thread's current provider/model.
- A task that is still running when its next time comes is skipped for that occurrence (server rule). Recurring
  occurrences missed while the server was down are skipped, not replayed.
- **One-time tasks** fire once; a `runAt` that passed while the app was closed fires when it next starts (the
  server has no grace window). `schedule run <ref>` runs it now without using up the scheduled run; `update
  --once <when>` moves it. Afterwards the task stays listed with `next -` and its last run status; `remove` it
  when you no longer need the record.
- `lastRunStatus` / `lastRunError` / `runCount` / `nextRunAt` are server fields; `schedule` shows them.

## Migrating from older t3ctl schedulers

Older t3ctl versions fired jobs from a launchd agent (`dev.t3ctl.scheduler`) running `t3ctl schedule tick` every
minute: ≤ 0.4 kept every job in `~/.config/t3ctl/schedule.json`, 0.6 kept one-shots in `~/.config/t3ctl/once.json`.
Both are now server tasks.

```
t3ctl schedule migrate                  # dry run: what would be created, what cannot be
t3ctl schedule migrate --apply          # create them, rename the files to *.legacy.json, remove the launchd agent
t3ctl schedule migrate --from <file>    # read another ≤ 0.4 file (default: schedule.json, else schedule.legacy.json)
```

Recurring cron jobs that T3 can express become recurring tasks; pending one-shots become `once` tasks (one already
late but inside its old `--grace` runs a minute from now). Jobs identical to an existing task (same target and
schedule) are skipped; past one-shots and non-expressible crons are listed with the reason. `schedule` points at
`migrate` while old state is left.

You rarely need to run it by hand: an agent left installed by t3ctl 0.6 keeps calling `schedule tick`, which now
migrates any pending `once.json` jobs and removes the agent on its next run.
