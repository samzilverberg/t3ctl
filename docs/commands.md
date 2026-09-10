# Command reference

Every command prints JSON when stdout is not a TTY or `T3CTL_AGENT=1`, a table otherwise (`-f json|table` forces).
`<ref>` is an id, an id prefix, or an exact title (projects also accept their workspace root).

```
t3ctl env                                  # which server we target (no auth)
t3ctl servers                              # every running T3 server on 127.0.0.1:3773-3780
t3ctl auth pair [--operate] | status | forget
t3ctl models [-a] [--no-legacy]            # models per provider + allowed effort / context-window values
t3ctl projects [list|show <ref>]
t3ctl projects add <path> [-t title] [-m model] [-e effort] [--create-dir]
t3ctl projects remove <ref> [--force]

t3ctl threads [list] [-p project] [-s status] [-a] [-n N]
t3ctl threads -i <id,id,…>                                   # status report for known ids
t3ctl threads show <ref> [-t turns]
t3ctl threads search <query>
t3ctl threads watch <ref> [--timeout s]                      # raw NDJSON event stream
t3ctl threads wait <ref> [--timeout s] [--require-turn]      # exit 0 idle · 2 needs-human · 3 error · 4 timeout
t3ctl threads new  -p <project> [-m model] [-e effort] [--context-window 1m] [--fast]
                   [-t title] [--env worktree|local] [--base br] [--branch br]
                   [--runtime-mode …] [--interaction-mode default|plan] [--no-setup-script]
                   [--wait] [--stdin] "<prompt>"
t3ctl threads new … --draft [--snooze <when>]                # create without starting a turn
t3ctl threads send <ref> [-m model] [-e effort] [--wait] "<prompt>"
t3ctl threads pending <ref>                                  # open approval / user-input requests
t3ctl threads approve <ref> [-d accept|acceptForSession|acceptAlways|decline] [-r requestId]
t3ctl threads respond <ref> -a <questionId>=<answer> … | --json '{…}'
t3ctl threads snooze <ref> -u <when> | unsnooze <ref>        # sidebar visibility only
t3ctl threads settle|unsettle <ref>
t3ctl threads interrupt|archive|unarchive <ref>

t3ctl schedule add <when> -p <project> [-m model] [-e effort] [-t title] [--env …] [--grace 30m] "<prompt>"
t3ctl schedule add <when> --thread <ref> [-m model] [-e effort] "<prompt>"
t3ctl schedule [list] [-a] | remove <id> | tick | install | uninstall
```

Global flags: `--origin <url>` (skip discovery; also `T3CTL_ORIGIN`), `-f json|table`, `--no-auto-pair`.
`T3CTL_TOKEN` overrides the Keychain. `T3CTL_CONFIG_DIR` relocates `~/.config/t3ctl`.

`<when>` = ISO, `30m`/`2h`/`3d`/`1w`, `HH:MM` (today, else tomorrow), or `"tomorrow [HH:MM]"` (default 09:00).
For `schedule add` it may also be a cron expression; see [scheduler.md](scheduler.md).

## Exit codes

`threads wait` (and `new --wait` / `send --wait`): `0` idle, `2` needs a human (approval or question), `3` turn
errored, `4` timeout, `5` aborted. Everything else: `0` success, `1` error (message on stderr).

## Thread status values

Derived the same way the UI does it: `running`, `idle`, `needs-approval`, `needs-input`, `error`, `interrupted`,
`archived`, `new`. `hasPendingApprovals` / `hasPendingUserInput` flags win over "running".

## Thread creation defaults

- **Model**: `--model` → project `defaultModelSelection` → server `textGenerationModelSelection`.
  `--effort` / `--context-window` / `--fast` are validated against the model's option descriptors from
  `server.getConfig` (`t3ctl models` prints them; `*` marks defaults).
- **Env**: `--env` → server `defaultThreadEnvMode` (yours: `worktree`). Worktree mode needs the project root to
  be a git checkout; base branch = `--base` or the checkout's current branch; worktree branch = `--branch` or
  `t3code/<hex>` like the desktop; `newWorktreesStartFromOrigin` is honoured; setup script runs unless
  `--no-setup-script`. Non-git roots fall back to `local`.
- **Modes**: `--runtime-mode` (default `auto`, or `defaults.runtimeMode`) and `--interaction-mode default|plan`.

---

## Snooze is not scheduling

T3's `thread.snooze` only hides the thread from the sidebar until `snoozedUntil` (the decider comment: "snooze
only affects visibility, never the agent"). A running turn keeps running; a draft stays a draft. The server
rejects snoozing a thread with a pending approval/user-input or a still-queued turn, so `new --snooze` waits for
the turn to be adopted before snoozing. There is no server-side deferred start; that is what `t3ctl schedule` is for.
