import { spawnSync } from "node:child_process";
import { APP_NAME } from "./config.js";

/**
 * macOS Keychain via the `security` CLI. No native deps.
 * Service = "t3ctl", account = per-environment key.
 * Override with T3CTL_TOKEN for CI/agents.
 */
const SERVICE = APP_NAME;

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("security", args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function keychainGet(account: string): string | undefined {
  if (process.env.T3CTL_TOKEN) return process.env.T3CTL_TOKEN;
  const r = run(["find-generic-password", "-s", SERVICE, "-a", account, "-w"]);
  if (r.status !== 0) return undefined;
  return r.stdout.trim() || undefined;
}

export function keychainSet(account: string, secret: string): void {
  // -U updates in place if the item exists.
  const r = run(["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", secret,
    "-j", "T3 Code bearer session issued to t3ctl"]);
  if (r.status !== 0) throw new Error(`keychain write failed: ${r.stderr.trim()}`);
}

export function keychainDelete(account: string): boolean {
  const r = run(["delete-generic-password", "-s", SERVICE, "-a", account]);
  return r.status === 0;
}
