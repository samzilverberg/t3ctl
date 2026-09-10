# Models

`-m` accepts, in this order: a t3ctl alias, an exact slug or server alias, or a fuzzy form where spaces/dots
become dashes and `claude-` is implied (`"Fable 5.0"` → `claude-fable-5`, `"opus 4.7"` → `claude-opus-4-7`).
Prefix with `instanceId/` to pin a provider. Built-in aliases deliberately differ from the server's own
(`opus`/`sonnet` on the server mean the 5.x line):

| alias | resolves to |
|---|---|
| `opus` | `claude-opus-4-8` |
| `fable` | `claude-fable-5-1` |
| `sonnet` | `claude-sonnet-4-6` |

Override or extend via `"modelAliases": { "opus": "claude-opus-5", "cheap": "haiku" }` in config.json.
`t3ctl models` lists legacy models too (`--no-legacy` hides them, `-a` adds disabled providers) and marks t3ctl aliases with `*`.

## Config defaults

`~/.config/t3ctl/config.json` may carry a `defaults` block used by `threads new` when flags are omitted:

```json
{ "defaults": { "runtimeMode": "auto", "interactionMode": "default", "model": "opus", "effort": "high", "env": "worktree" } }
```

Built-in runtime mode default is `auto` (T3 Code's own default is `full-access`). Model resolution order for
`threads new`: `-m` → `defaults.model` → project default → server default.
