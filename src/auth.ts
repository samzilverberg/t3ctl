import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { T3_HOME, readConfig, writeConfig } from "./config.js";
import { keychainDelete, keychainGet, keychainSet } from "./keychain.js";
import type { Server } from "./discover.js";

/** Scopes this CLI requests. Read-only by default; `operate` only when a write command needs it. */
export const READ_SCOPES = ["orchestration:read"];
export const OPERATE_SCOPES = ["orchestration:read", "orchestration:operate"];
export const DEFAULT_LABEL = `t3ctl@${hostname()}`;

export function accountKey(server: Server): string {
  return server.descriptor.environmentId;
}

/**
 * Locate the installed `t3` server CLI (same version as the running app) so we can mint a pairing
 * credential the official way (`t3 auth pairing create`), which writes a one-time grant into the
 * app's own SQLite. We never touch the DB ourselves.
 */
export function findT3Bin(serverVersion: string): string[] {
  const statePath = join(T3_HOME, "runtime", "service-state.json");
  let active = serverVersion;
  if (existsSync(statePath)) {
    try { active = (JSON.parse(readFileSync(statePath, "utf8")) as { activeVersion?: string }).activeVersion ?? active; } catch { /* ignore */ }
  }
  for (const v of [active, serverVersion]) {
    const bin = join(T3_HOME, "runtime", "versions", v, "node_modules", "t3", "dist", "bin.mjs");
    if (existsSync(bin)) return [process.execPath, bin];
  }
  return ["npx", "-y", `t3@${serverVersion}`];
}

interface PairingCredential { id: string; credential: string; label?: string; scopes: string[]; expiresAt: string }

export function mintPairingCredential(server: Server, label: string): PairingCredential {
  const [cmd, ...pre] = findT3Bin(server.descriptor.serverVersion);
  const args = [...pre, "auth", "pairing", "create", "--json", "--ttl", "2m", "--label", label];
  const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  if (r.status !== 0) throw new Error(`t3 auth pairing create failed:\n${r.stderr}`);
  const jsonStart = r.stdout.indexOf("{");
  if (jsonStart < 0) throw new Error(`unexpected pairing output:\n${r.stdout}`);
  return JSON.parse(r.stdout.slice(jsonStart)) as PairingCredential;
}

interface TokenResponse { access_token: string; token_type: string; expires_in: number; scope: string }

/** RFC 8693 token exchange: one-time pairing credential → 30-day bearer session. */
export async function exchangePairingCredential(server: Server, credential: string, scopes: string[], label: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: credential,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    scope: scopes.join(" "),
    client_label: label,
    client_device_type: "desktop",
    client_os: process.platform,
  });
  const r = await fetch(`${server.origin}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`token exchange failed: ${r.status} ${await r.text()}`);
  return (await r.json()) as TokenResponse;
}

export interface PairResult { token: string; scopes: string[]; expiresAt: string }

/**
 * Full pairing: mint → exchange → store. Non-interactive (the mint uses the local `t3` binary and the
 * app's own DB; the Keychain write may prompt once per new t3ctl binary). Safe to call automatically.
 */
export async function pair(server: Server, opts: { label?: string; operate: boolean }): Promise<PairResult> {
  const label = opts.label ?? DEFAULT_LABEL;
  const scopes = opts.operate ? OPERATE_SCOPES : READ_SCOPES;
  const cred = mintPairingCredential(server, label);
  const tok = await exchangePairingCredential(server, cred.credential, scopes, label);
  const expiresAt = new Date(Date.now() + tok.expires_in * 1000).toISOString();
  const account = accountKey(server);
  keychainSet(account, tok.access_token);
  const granted = tok.scope.split(" ");
  writeConfig({ ...readConfig(), origin: server.origin, environmentId: server.descriptor.environmentId, keychainAccount: account, scopes: granted, expiresAt, label });
  return { token: tok.access_token, scopes: granted, expiresAt };
}

/**
 * Return a usable token that has `needScopes`. Re-pairs automatically when: no token stored, token
 * expired (per stored expiry), or the stored scopes lack what the command needs. Callers should also
 * retry once via `repairOn401` when the server rejects a token we believed valid (revoked in UI).
 */
export async function ensureToken(server: Server, needScopes: string[] = READ_SCOPES, opts: { autoPair?: boolean } = {}): Promise<string> {
  const cfg = readConfig();
  const stored = keychainGet(accountKey(server));
  const have = new Set(cfg.scopes ?? []);
  const missing = needScopes.filter((s) => !have.has(s));
  const expired = cfg.expiresAt ? Date.parse(cfg.expiresAt) - Date.now() < 60_000 : false;
  if (stored && !expired && missing.length === 0) return stored;
  if (opts.autoPair === false) {
    throw new Error(stored ? `Stored session lacks scopes [${missing.join(", ")}] or is expired. Run: t3ctl auth pair${missing.includes("orchestration:operate") ? " --operate" : ""}` : `Not paired with ${server.descriptor.label} (${server.origin}). Run: t3ctl auth pair`);
  }
  // Keep operate if we already had it, or if the caller needs it.
  const operate = have.has("orchestration:operate") || needScopes.includes("orchestration:operate");
  const why = !stored ? "no stored token" : expired ? "token expired" : `missing scopes ${missing.join(",")}`;
  process.stderr.write(`t3ctl: re-pairing with ${server.descriptor.label} (${why})…\n`);
  const res = await pair(server, { label: cfg.label, operate });
  return res.token;
}

export function forget(server: Server): boolean {
  const ok = keychainDelete(accountKey(server));
  const cfg = readConfig();
  delete cfg.keychainAccount; delete cfg.scopes; delete cfg.expiresAt;
  writeConfig(cfg);
  return ok;
}
