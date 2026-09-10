# Auth and tokens

- The Keychain holds a **30-day** bearer session (server TTL, not configurable client-side). Its scopes and
  expiry are mirrored in `config.json`.
- Re-pairing is **automatic and non-interactive**: when the token is missing, within 60 s of expiry, lacks a
  scope the command needs (e.g. first write → `orchestration:operate`), or the server answers 401 (revoked
  in the UI), t3ctl mints a fresh pairing credential via the installed `t3 auth pairing create`, exchanges it,
  and overwrites the Keychain item. A one-line notice goes to stderr. `--no-auto-pair` turns this into an error.
- Read-only by default. The first `threads new/send/interrupt/archive` upgrades the session to
  `orchestration:read orchestration:operate`; the upgraded session is kept afterwards.
- Each pairing shows up as a connection in T3 Code → Settings → Connections; revoke stale ones there.

## How pairing works (protocol)

- Every request and WS upgrade needs a credential; `network-accessible` changes bind host only.
  No loopback bypass.
- Sessions are scoped bearer tokens (30 d): `orchestration:read`, `orchestration:operate`,
  `terminal:operate`, `review:write`, `relay:read`, plus admin `access:*`, `relay:write`.
- Pairing flow (what `t3 pair` / the mobile app do, and what `t3ctl auth pair` does):
  1. `t3 auth pairing create --json --ttl 2m` (installed runtime bin at
     `~/.t3/runtime/versions/<v>/node_modules/t3/dist/bin.mjs`) → one-time credential, written into
     the app's own DB by the official CLI.
  2. `POST /oauth/token` RFC 8693 token exchange, requesting **only `orchestration:read`** by default.
  3. Store bearer in Keychain (`security add-generic-password -s t3ctl -a <environmentId>`).
- Node `ws` can send `Authorization: Bearer` on the upgrade, so the browser-only `wsTicket`
  dance is unnecessary.
- Sessions appear in T3 Code → Connections and can be revoked there.
