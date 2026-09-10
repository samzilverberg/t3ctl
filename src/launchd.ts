/** macOS launchd LaunchAgent that runs `t3ctl schedule tick` every minute in the user's login session. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOG_PATH } from "./schedule.js";

export const LAUNCHD_LABEL = "dev.t3ctl.scheduler";
export const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const INTERVAL_SEC = 60;

function domain(): string { return `gui/${process.getuid?.() ?? 501}`; }

function launchctl(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("launchctl", args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function esc(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

/** Absolute paths only: launchd has no shell, no mise, no PATH from your dotfiles. */
export function buildPlist(): string {
  const node = process.execPath;
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  const path = [dirname(node), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(node)}</string>
    <string>${esc(entry)}</string>
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
  <key>StandardOutPath</key><string>${esc(LOG_PATH)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG_PATH)}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

export function install(): { plist: string; node: string; entry: string } {
  mkdirSync(dirname(PLIST_PATH), { recursive: true });
  if (existsSync(PLIST_PATH)) launchctl(["bootout", `${domain()}/${LAUNCHD_LABEL}`]);
  writeFileSync(PLIST_PATH, buildPlist(), { mode: 0o644 });
  const r = launchctl(["bootstrap", domain(), PLIST_PATH]);
  if (!r.ok) throw new Error(`launchctl bootstrap failed: ${r.out}`);
  return { plist: PLIST_PATH, node: process.execPath, entry: fileURLToPath(new URL("./index.js", import.meta.url)) };
}

export function uninstall(): { removed: boolean } {
  const existed = existsSync(PLIST_PATH);
  launchctl(["bootout", `${domain()}/${LAUNCHD_LABEL}`]);
  if (existed) unlinkSync(PLIST_PATH);
  return { removed: existed };
}

export function isLoaded(): boolean {
  return launchctl(["print", `${domain()}/${LAUNCHD_LABEL}`]).ok;
}
