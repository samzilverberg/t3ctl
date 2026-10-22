/**
 * macOS LaunchAgent that runs `t3ctl schedule tick` every minute in the user's login session. Only client-side
 * one-shot jobs (src/once.ts) need it; recurring tasks fire from the T3 Code server. Set T3CTL_NO_LAUNCHD=1 to make
 * install/uninstall no-ops (the test suite does, so it never touches the real agent).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ONCE_LOG_PATH } from "./once.js";

export const LAUNCHD_LABEL = "dev.t3ctl.scheduler";
export const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const INTERVAL_SEC = 60;
const disabled = () => process.env.T3CTL_NO_LAUNCHD === "1";

function domain(): string { return `gui/${process.getuid?.() ?? 501}`; }

function launchctl(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("launchctl", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function esc(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

const entryPath = () => fileURLToPath(new URL("./index.js", import.meta.url));

/** Absolute paths only: launchd has no shell, no mise, no PATH from your dotfiles. */
export function buildPlist(): string {
  const node = process.execPath;
  const path = [dirname(node), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(node)}</string>
    <string>${esc(entryPath())}</string>
    <string>schedule</string>
    <string>tick</string>
  </array>
  <key>StartInterval</key><integer>${INTERVAL_SEC}</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(path)}</string>
    <key>HOME</key><string>${esc(homedir())}</string>
    <key>T3CTL_AGENT</key><string>1</string>
  </dict>
  <key>StandardOutPath</key><string>${esc(ONCE_LOG_PATH)}</string>
  <key>StandardErrorPath</key><string>${esc(ONCE_LOG_PATH)}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

export function install(): { installed: boolean; plist: string; node: string; entry: string } {
  if (disabled()) return { installed: false, plist: PLIST_PATH, node: process.execPath, entry: entryPath() };
  mkdirSync(dirname(PLIST_PATH), { recursive: true });
  if (existsSync(PLIST_PATH)) launchctl(["bootout", `${domain()}/${LAUNCHD_LABEL}`]);
  writeFileSync(PLIST_PATH, buildPlist(), { mode: 0o644 });
  const r = launchctl(["bootstrap", domain(), PLIST_PATH]);
  if (!r.ok) throw new Error(`launchctl bootstrap failed: ${r.out}`);
  return { installed: true, plist: PLIST_PATH, node: process.execPath, entry: entryPath() };
}

export function uninstall(): { removed: boolean } {
  if (disabled()) return { removed: false };
  const existed = existsSync(PLIST_PATH);
  launchctl(["bootout", `${domain()}/${LAUNCHD_LABEL}`]);
  if (existed) unlinkSync(PLIST_PATH);
  return { removed: existed };
}

export function isLoaded(): boolean {
  if (disabled()) return false;
  return launchctl(["print", `${domain()}/${LAUNCHD_LABEL}`]).ok;
}
