# Agents and task trackers

## Skill for Claude Code

`skills/t3ctl/SKILL.md` teaches an agent when and how to call t3ctl. Symlink it into `~/.claude/skills/t3ctl` so
every Claude Code session (user scope) discovers it, including sessions running inside T3 Code:

```sh
ln -s "$PWD/skills/t3ctl" ~/.claude/skills/t3ctl
```

Agents get JSON automatically (stdout is not a TTY); set `T3CTL_AGENT=1` to force it.

## Optional: pairing with a task tracker

t3ctl is tracker-agnostic. If you run tasks from a notes app or tracker (Obsidian, a markdown planner, Jira…),
pair them by convention rather than code:

- **Task ↔ thread pairing**: store the thread id on the task (frontmatter or a field), e.g. `t3-thread: <uuid>`,
  `t3-status: running|idle|needs-human|done`, `t3-updated: <iso>`. `threads new` prints `threadId` as JSON; the
  agent writes it back with whatever CLI/API the tracker has. Reverse lookup: `t3ctl threads search "<title>"`
  or put the task reference in the first prompt line.
- **Model / effort choice**: per-task fields (`t3-model: sonnet`, `t3-effort: low`) or a policy in your agent
  instructions, e.g. small chores → `sonnet@low`, code changes → `opus@high`, research/design → `fable@xhigh`.
  Absent → project default.
- **Progress**: `t3ctl threads -i <ids>` for a batch status report, `threads show <id> -t 1` for the latest
  assistant message, `threads wait <id>` (exit code) for blocking flows, `threads -s needs-approval` for a
  "needs me" view. `schedule add` covers deferred and recurring tasks without any tracker.
