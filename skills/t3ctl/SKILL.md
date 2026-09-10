---
name: t3ctl
description: Read, create and drive T3 Code sessions from the terminal via the t3ctl CLI. Use when asked to list T3 Code threads/projects, check whether a delegated T3 Code session is running or idle, read a thread's latest messages, search past threads, start a new T3 Code thread for a task (choosing project, model and reasoning effort), send a follow-up, or wait for a thread to finish.
---

# t3ctl — control the running T3 Code app

`t3ctl` (on PATH via `pnpm link --global`) talks to the T3 Code desktop app already running on this Mac.
It never starts a server. Always run with `T3CTL_AGENT=1` and parse JSON; never scrape tables.

```sh
T3CTL_AGENT=1 t3ctl <command>
```

Auth is automatic: the CLI re-pairs itself when its token is missing, expired, revoked, or lacks a scope.
Only if it prints "t3 auth pairing create failed" should you tell the user to check that T3 Code is running.

## Read

| Need | Command → JSON |
|---|---|
| Server / version | `t3ctl env` (must say "desktop backend = what the UI uses"; `t3ctl servers` lists all) |
| Projects | `t3ctl projects` → `[{id,title,workspaceRoot,threadCount}]` |
| Models + allowed efforts | `t3ctl models` → `[{instanceId,model,aliases,effort:"low|medium|high*|…"}]` |
| Active threads | `t3ctl threads` → `[{id,title,status,projectTitle,branch,worktreePath,modelSelection,updatedAt}]` |
| Filter | `t3ctl threads -p mono -s running`; `-a` includes archived |
| Thread + last N turns | `t3ctl threads show <ref> -t 2` → `{status, thread:{messages:[{role,text,createdAt}]}}` |
| Find by content | `t3ctl threads search "<words>"` → `[{threadId,source,snippet}]` |

`status`: `running`, `idle`, `needs-approval`, `needs-input`, `error`, `interrupted`, `archived`, `new`.
`<ref>` = full id, id prefix, or exact title. Prefer full ids in anything you write down.

## Write

| Need | Command |
|---|---|
| New thread | `t3ctl threads new -p <project> -m <model> -e <effort> -t "<title>" "<prompt>"` → `{threadId, url, env, branch}` |
| …and block until first turn ends | add `--wait --timeout 1800` → `{…, wait:{status,reason,lastAssistantText}}` |
| Follow-up | `t3ctl threads send <ref> "<prompt>" [--wait]` |
| Block on a running thread | `t3ctl threads wait <ref> --timeout 1800` (exit 0 idle · 2 needs-human · 3 error · 4 timeout) |
| What is it blocked on | `t3ctl threads pending <ref>` → `{approvals:[{requestId,requestKind,detail,options}], userInputs:[{requestId,questions:[{id,question,options:[{label}]}]}]}` |
| Approve / decline | `t3ctl threads approve <ref> -d accept` (or `decline`, `acceptForSession`, `acceptAlways`; `-r <requestId>` to pick one) |
| Answer questions | `t3ctl threads respond <ref> -a <questionId>=<option label> …` |
| Hide until later (visibility only) | `t3ctl threads snooze <ref> -u "tomorrow 09:00"` / `t3ctl threads unsnooze <ref>` |
| Create without starting | `t3ctl threads new -p <project> --draft -t "<title>" [--snooze 2h]` |
| Done for now / tidy | `t3ctl threads settle <ref>` (keeps it, leaves inbox), `t3ctl threads archive <ref>`, `t3ctl threads interrupt <ref>` |
| Register a repo | `t3ctl projects add <path> [-m model -e effort]` |
| Run later / on a cron | `t3ctl schedule add "<when>" -p <project> [-m model -e effort -t title] "<prompt>"` → `{id, nextAt, tickerInstalled}`; `<when>` = `30m`, `"tomorrow 09:00"`, ISO, or cron (`"0 9 * * 1-5"`, `@daily`) |
| Scheduled follow-up | `t3ctl schedule add "<when>" --thread <ref> "<prompt>"` |
| See / cancel schedules | `t3ctl schedule` (pending jobs, last run, ticker status) · `t3ctl schedule remove <id>` |

Long prompts: `printf '%s' "$PROMPT" | t3ctl threads new -p mono -m opus -e high --stdin`.

## Choosing project, model, effort

- Project: match the task's repo (`t3ctl projects` → `workspaceRoot`). Never guess; ask if no project matches.
- Model refs: t3ctl aliases `opus` = Opus 4.8, `fable` = Fable 5.1, `sonnet` = Sonnet 4.6 (these differ from the
  server's own aliases). Specific versions work fuzzily: `"opus 5"`, `"fable 5.0"`, `"sonnet 5"`, `haiku`.
  `t3ctl models -a` lists everything.
- Model/effort policy unless the task note says otherwise (`t3-model:` / `t3-effort:` frontmatter):
  chores, formatting, docs → `sonnet -e low`; code changes with tests → `opus -e high`;
  research, design, ambiguous scope → `fable -e xhigh`.
- Worktree is the default env for git projects; pass `--env local` only when the task must touch the main checkout.

## Rules

- `needs-approval` / `needs-input`: run `threads pending` and show the user exactly what is being asked. Only
  approve yourself when the user has pre-authorised that class of action for the task; otherwise report and stop.
- Never `interrupt`/`archive` a thread you did not create unless the user names it explicitly.
- Do not send a message to a `running` thread; `wait` first.
- Each `threads new` (without `--draft`) starts a paid agent turn. One thread per task; use `send` for follow-ups.
- Snooze hides a thread; it does not delay or schedule work. To run a task later use `schedule add`. The thread id
  only exists after the job fires: read it from `t3ctl schedule -a` (`runs[].threadId`).
- Scheduler rules are fixed: one fire per occurrence, missed occurrences dropped, late fires skipped after the grace
  window (60m or half the cron interval), recurring jobs skip while the previous run's thread is running or waiting
  on a human. If `tickerInstalled` is false, tell the user to run `t3ctl schedule install`.
- Omitting `-m` uses the config default (`opus` = Opus 4.8), then the project default.

## Optional: driving t3ctl from a task tracker

t3ctl does not know about any notes app or tracker. If the user runs tasks from one (Obsidian, a markdown
planner, an issue tracker), the pairing is a convention you keep in that tool:

- Store the thread id on the task (e.g. frontmatter/field `t3-thread: <uuid>`, plus `t3-status`, `t3-updated`).
  `threads new` and `schedule -a` print ids as JSON.
- Delegate: `t3ctl threads new -p <project> -m <model> -e <effort> -t "<task title>" "<prompt incl. task
  reference + deliverable>"`, then record the id and `t3-status: running` right away.
- Sync loop: `t3ctl threads -i id1,id2,…` for all tracked ids → surface `needs-human` first, then `idle`
  (`t3ctl threads show <id> -t 1`), then `running`; update status fields.
- Close: mark the task done, `t3ctl threads archive <id>`. Archive only threads the tracker references.
- Reverse lookup when an id was lost: `t3ctl threads search "<task title>"`.
