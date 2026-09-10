---
name: t3ctl
description: Read, create and drive T3 Code sessions from the terminal via the t3ctl CLI. Use when asked to list T3 Code threads/projects, check whether a delegated T3 Code session is running or idle, read a thread's latest messages, search past threads, start a new T3 Code thread for a task (choosing project, model and reasoning effort), send a follow-up, or wait for a thread to finish.
---

# t3ctl — control the running T3 Code app

`t3ctl` (on PATH at `~/.local/bin/t3ctl`) talks to the T3 Code desktop app already running on this Mac.
It never starts a server. Always run with `T3CTL_AGENT=1` and parse JSON; never scrape tables.

```sh
T3CTL_AGENT=1 t3ctl <command>
```

Auth is automatic: the CLI re-pairs itself when its token is missing, expired, revoked, or lacks a scope.
Only if it prints "t3 auth pairing create failed" should you tell the user to check that T3 Code is running.

## Read

| Need | Command → JSON |
|---|---|
| Server / version | `t3ctl env` |
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
| Stop / tidy | `t3ctl threads interrupt <ref>`, `t3ctl threads archive <ref>` |

Long prompts: `printf '%s' "$PROMPT" | t3ctl threads new -p mono -m opus -e high --stdin`.

## Choosing project, model, effort

- Project: match the task's repo (`t3ctl projects` → `workspaceRoot`). Never guess; ask if no project matches.
- Model/effort policy unless the task note says otherwise (`t3-model:` / `t3-effort:` frontmatter):
  chores, formatting, docs → `sonnet -e low`; code changes with tests → `opus -e high`;
  research, design, ambiguous scope → `fable -e xhigh`. Validate with `t3ctl models` if unsure.
- Worktree is the default env for git projects; pass `--env local` only when the task must touch the main checkout.

## Rules

- `needs-approval` / `needs-input` means a human must act in the T3 Code UI. Report it; do not wait or retry.
- Never `interrupt`/`archive` a thread you did not create unless the user names it explicitly.
- Do not send a message to a `running` thread; `wait` first.
- Each `threads new` starts a paid agent turn. One thread per task; use `send` for follow-ups.

## Obsidian handoff pattern

1. Read the task note; pick project/model/effort per the policy above.
2. `t3ctl threads new … "<prompt that includes the note path and the deliverable>"` and write the returned
   `threadId` into the note's frontmatter as `t3-thread`, plus `t3-status: running`.
3. Later: `t3ctl threads show <id> -t 1` → summarize the last assistant message into the note;
   set `t3-status` from the `status` field.
