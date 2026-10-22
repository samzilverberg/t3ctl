/**
 * Leftover from t3ctl ≤ 0.4, which ran its own scheduler via a launchd LaunchAgent (`t3ctl schedule tick` every
 * minute). T3 Code 0.1 has a built-in scheduler, so the agent is only ever removed now (`schedule migrate`).
 */
import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LAUNCHD_LABEL = "dev.t3ctl.scheduler";
export const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);

function domain(): string { return `gui/${process.getuid?.() ?? 501}`; }

function launchctl(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("launchctl", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

export function uninstall(): { removed: boolean } {
  const existed = existsSync(PLIST_PATH);
  launchctl(["bootout", `${domain()}/${LAUNCHD_LABEL}`]);
  if (existed) unlinkSync(PLIST_PATH);
  return { removed: existed };
}

export function isLoaded(): boolean {
  return existsSync(PLIST_PATH) || launchctl(["print", `${domain()}/${LAUNCHD_LABEL}`]).ok;
}
