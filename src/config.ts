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
  /** ISO expiry of the stored session. */
  expiresAt?: string;
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
