/**
 * Cleanup for the retired launchd ticker. t3ctl ≤ 0.6 installed a LaunchAgent (dev.t3ctl.scheduler) that ran
 * `t3ctl schedule tick` every minute to fire client-side jobs. T3 Code 0.1.7 schedules one-shots itself, so the agent
 * is only ever removed now (`schedule migrate --apply`, or the hidden `schedule tick` the old agent still calls).
 * Set T3CTL_NO_LAUNCHD=1 to make this a no-op (the test suite does, so it never touches the real agent).
 */
import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LAUNCHD_LABEL = "dev.t3ctl.scheduler";
export const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const disabled = () => process.env.T3CTL_NO_LAUNCHD === "1";
const target = () => `gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`;

/** Whether the old ticker is still installed (plist present or agent loaded). */
export function tickerPresent(): boolean {
  if (disabled()) return false;
  return existsSync(PLIST_PATH) || spawnSync("launchctl", ["print", target()]).status === 0;
}

/** Unload the agent and delete its plist. Safe to call from the agent itself: launchd kills us last. */
export function retireTicker(): { removed: boolean } {
  if (disabled()) return { removed: false };
  const existed = tickerPresent();
  if (existsSync(PLIST_PATH)) unlinkSync(PLIST_PATH);
  spawnSync("launchctl", ["bootout", target()]);
  return { removed: existed };
}
