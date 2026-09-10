import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_NAME = "t3ctl";
export const CONFIG_DIR = process.env.T3CTL_CONFIG_DIR ?? join(homedir(), ".config", APP_NAME);
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const T3_HOME = process.env.T3CODE_HOME ?? join(homedir(), ".t3");

export interface Config {
  /** Explicit server origin, e.g. http://127.0.0.1:3773. Optional; discovery runs otherwise. */
  origin?: string;
  /** Environment id of the server we paired with (from /.well-known/t3/environment). */
  environmentId?: string;
  /** Keychain account key under which the bearer token is stored. */
  keychainAccount?: string;
  /** Scopes granted to our stored session. */
  scopes?: string[];
  /** Connection label used when pairing. */
  label?: string;
  /** ISO expiry of the stored session. */
  expiresAt?: string;
  /** Defaults applied by `threads new` when flags are omitted. */
  defaults?: { runtimeMode?: string; interactionMode?: string; model?: string; effort?: string; env?: string };
  /** User model aliases (alias → slug or server alias). Merged over BUILTIN_MODEL_ALIASES. */
  modelAliases?: Record<string, string>;
}

/** Our own short names. The server's own `opus`/`sonnet` aliases point at the 5.x line; Sam wants these. */
export const BUILTIN_MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-8",
  fable: "claude-fable-5-1",
  sonnet: "claude-sonnet-4-6",
};

export function modelAliases(): Record<string, string> {
  return { ...BUILTIN_MODEL_ALIASES, ...(readConfig().modelAliases ?? {}) };
}

export function readConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
  } catch {
    return {};
  }
}

export function writeConfig(next: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
}
