# t3ctl

Control an **already-running** [T3 Code](https://t3.gg) desktop app from the terminal: list and read threads,
start new ones (project, model, reasoning effort), send follow-ups, answer approvals, wait for results, and
schedule threads for later or on a cron. Built for humans at a shell and for agents that delegate work to
T3 Code sessions.

t3ctl never starts a server. It finds the app's own backend, pairs with it once (token in the macOS Keychain) and
talks to it over the same HTTP/WebSocket API the UI uses. macOS, Node ≥ 22, pnpm.

## Install

```sh
git clone https://github.com/samzilverberg/t3ctl && cd t3ctl
pnpm install            # builds dist/
pnpm link --global      # puts `t3ctl` on PATH (via $PNPM_HOME)
t3ctl env               # finds the running app; first write command pairs automatically
```

## Quick tour

```sh
t3ctl threads                                      # what is running / idle / waiting on you
t3ctl threads show <ref> -t 1                      # latest exchange
t3ctl threads new -p myrepo -m opus -e high "Fix the flaky login test"
t3ctl threads wait <ref>                           # exit 0 idle · 2 needs you · 3 error · 4 timeout
t3ctl threads pending <ref> && t3ctl threads approve <ref>
t3ctl threads send <ref> "Also add a regression test"
t3ctl schedule add "tomorrow 09:00" -p myrepo "Triage new issues"
t3ctl schedule add "0 9 * * 1-5" --thread <ref> "Daily: summarise open PRs"
```

`<ref>` is an id, an id prefix, or an exact title. `-m` takes a slug or an alias (`opus`, `sonnet`, `fable`).
Output is a table on a TTY and JSON otherwise, so the same commands work in scripts and for agents.

## Docs

- [Command reference](docs/commands.md) — every command, flag, exit code and status value.
- [Scheduler](docs/scheduler.md) — one-shot and cron jobs, the launchd ticker, grace and overlap rules.
- [Models and defaults](docs/models.md) — aliases, fuzzy refs, config `defaults`.
- [Auth and tokens](docs/auth.md) — pairing, Keychain, automatic re-pairing, scopes.
- [Agents and task trackers](docs/agents.md) — the Claude Code skill, pairing threads with your own task list.
- [How T3 Code is controlled](docs/architecture.md) — transports, the two local servers, the write surface.
- [AGENTS.md](AGENTS.md) — working on this repo (build discipline, live validation, tests).

## Development

```sh
pnpm dev <args>     # run from source
pnpm test           # unit tests against recorded fixtures (test/fixtures)
pnpm build          # required after changes: the global link runs dist/
```

Status: v0.1.0, verified against T3 Code 0.0.40 (2026-09-10). The protocol is internal to T3 Code and
unversioned; expect to re-check after app updates. MIT.
