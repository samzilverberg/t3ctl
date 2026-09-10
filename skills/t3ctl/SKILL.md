---
name: t3ctl
description: Read and (later) drive T3 Code sessions from the terminal via the t3ctl CLI. Use when asked to list T3 Code threads/projects, check whether a delegated T3 Code session is running or idle, read a thread's latest messages, search past threads, or wait for a thread to finish.
---

# t3ctl — control the running T3 Code app

`t3ctl` talks to the T3 Code desktop app already running on this Mac. It never starts a server.
Run it from `~/dev/t3ctl`:

```sh
cd ~/dev/t3ctl && T3CTL_AGENT=1 npx tsx src/index.ts <command>
```

`T3CTL_AGENT=1` (or any non-TTY) forces JSON output. Always parse JSON; never scrape tables.

## Commands (read-only)

| Need | Command |
|---|---|
| Which server / version | `t3ctl env` |
| Am I paired | `t3ctl auth status` → `{authenticated, scopes}` |
| Projects | `t3ctl projects` → `[{id,title,workspaceRoot,threadCount}]` |
| Active threads | `t3ctl threads` → `[{id,title,status,projectTitle,branch,worktreePath,modelSelection,updatedAt,...}]` |
| Filter | `t3ctl threads -p mono -s running`, `-a` includes archived |
| One thread + last N turns | `t3ctl threads show <id-or-prefix-or-title> -t 3` → `{thread:{messages:[{role,text,createdAt}]}}` |
| Find by content | `t3ctl threads search "<words>"` → `[{threadId,source,snippet}]` |
| Block until turn ends | `t3ctl threads watch <ref> --until-idle --timeout 1800` (NDJSON events on stdout; exits when idle) |

`status` values: `running`, `idle`, `needs-approval`, `needs-input`, `error`, `interrupted`, `archived`, `new`.

## Rules

- Refer to threads by full `id` in notes you write; prefixes are for humans.
- `needs-approval` / `needs-input` means a human must act in the T3 Code UI. Report it, do not wait.
- If `auth status` fails with "Not paired", tell the user to run `t3ctl auth pair` (interactive Keychain step). Do not attempt to mint tokens yourself.
- Write commands (`threads new`, `threads send`, approvals) are not implemented yet; do not simulate them.

## Obsidian handoff pattern (management session)

1. Read the task note. 2. `t3ctl threads -s running` to see load. 3. (future) `t3ctl threads new …` and paste the returned thread id into the note's `t3-thread:` property. 4. Later, `t3ctl threads show <id> -t 1` to summarize progress back into the note.
