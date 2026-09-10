# Scheduler

`t3ctl schedule` runs threads later or on a cron, client-side. Jobs live in `~/.config/t3ctl/schedule.json`; a
LaunchAgent (`dev.t3ctl.scheduler`, installed once with `t3ctl schedule install`) runs `t3ctl schedule tick` every
60 s while you are logged in and appends one line per action to `~/.config/t3ctl/scheduler.log`. The plist
hardcodes the current `node` and `dist/index.js` paths, so re-run `install` if either moves.

```
t3ctl schedule add "tomorrow 09:00" -p mono -m opus -e high -t "Nightly triage" "Triage open issues…"
t3ctl schedule add "0 9 * * 1-5" -p mono "Weekday morning: …"        # cron → recurring, new thread each time
t3ctl schedule add @hourly --thread <ref> "Check the board and report"  # recurring follow-up into one thread
t3ctl schedule                                                         # pending jobs + ticker status
t3ctl schedule remove <id>
```

`<when>` is either a one-shot (`30m`, `2h`, `HH:MM`, `"tomorrow 09:00"`, ISO) or a cron expression (5 fields,
or `@hourly` / `@daily` / `@weekly`; local time zone). Targets and model refs are validated when you `add`.

Fixed rules, no knobs beyond `--grace`:

- **At most one fire per occurrence, never replayed.** Missed occurrences (Mac asleep, logged out) are dropped;
  only the most recent due one is considered when the ticker next runs.
- **Grace window.** An occurrence fires only if the ticker reaches it within `--grace` of its time (default 60 m,
  or half the cron interval if smaller). Otherwise it is recorded as `skipped (late by …)`.
- **No overlap.** A recurring job skips an occurrence while the thread from its previous run is `running` or
  waiting on a human (`needs-approval` / `needs-input`). Resolve the pending request to unblock it.
- **Failures stick.** A failed fire (project gone, model retired, server down) is recorded with its reason and not
  retried; the recurring job moves on to its next occurrence. `schedule list -a` shows finished one-shots too.

Limitations: launchd cannot wake a sleeping Mac, so "09:00" means "the first minute the Mac is awake and you are
logged in at or after 09:00, within grace". If the desktop app is closed the ticker falls back to the background
service (if installed); the UI catches up from SQLite when reopened.
