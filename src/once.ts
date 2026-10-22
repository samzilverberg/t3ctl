/**
 * Client-side one-shot jobs. T3 Code's scheduler (0.1.x) has interval / fixed-time / webhook schedules and nothing that
 * fires once at a date (upstream: discussions #6748, #20863). Until it does, `schedule add --once <when>` keeps the
 * job here, in ~/.config/t3ctl/once.json, and a launchd ticker runs `t3ctl schedule tick` every minute. Recurring
 * work never comes through here; it is the server's, so nothing can double-fire between the two.
 *
 * Rules (fixed): a job fires at most once; a fire that is late by more than `graceSec` (default 60m, e.g. the Mac was
 * asleep) is recorded as `missed`, never replayed; fired/missed/failed jobs stay in the file for `schedule list -a`.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CONFIG_DIR } from "./config.js";
import { CliError } from "./errors.js";
import { parseWhen } from "./time.js";
import type { InteractionMode, RuntimeMode } from "./ops.js";

export const ONCE_PATH = join(CONFIG_DIR, "once.json");
export const ONCE_LOCK_PATH = join(CONFIG_DIR, "once.lock");
export const ONCE_LOG_PATH = join(CONFIG_DIR, "scheduler.log");
export const DEFAULT_GRACE_SEC = 3600;
const MAX_FINISHED = 50;

export type OnceStatus = "pending" | "fired" | "missed" | "failed";

export interface OnceJob {
  id: string;
  createdAt: string;
  /** When to fire (ISO, UTC). */
  at: string;
  /** How late the ticker may still fire it (seconds). */
  graceSec: number;
  title: string;
  /** New thread in a project (ids are resolved at add time) … */
  new?: { project: string; projectTitle?: string; text: string; model?: string; effort?: string; title?: string; env?: string; base?: string; branch?: string; runtimeMode?: RuntimeMode; interactionMode?: InteractionMode };
  /** … or a message into an existing thread (queued if it is busy). */
  send?: { thread: string; text: string; model?: string; effort?: string };
  status: OnceStatus;
  firedAt?: string;
  threadId?: string;
  sequence?: number;
  reason?: string;
}

interface Store { jobs: OnceJob[] }

export function readOnce(path = ONCE_PATH): OnceJob[] {
  try { return (JSON.parse(readFileSync(path, "utf8")) as Store).jobs ?? []; } catch { return []; }
}

export function writeOnce(jobs: OnceJob[], path = ONCE_PATH): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ jobs }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

export const newOnceId = () => `once:${randomBytes(4).toString("hex")}`;

/** `<when>` for a one-shot: must parse and lie in the future (ISO, 30m/2h/3d, HH:MM, "tomorrow [HH:MM]"). */
export function parseOnceAt(when: string, now = new Date()): string {
  const at = parseWhen(when, now);
  if (Date.parse(at) <= now.getTime()) throw new CliError("invalid_option", `--once ${when} is in the past (${at})`, { option: "once", at });
  return at;
}

export type OnceEvaluation = { due: false } | { due: true; lateSec: number; withinGrace: boolean };

export function evaluateOnce(job: OnceJob, now = new Date()): OnceEvaluation {
  if (job.status !== "pending") return { due: false };
  const lateMs = now.getTime() - Date.parse(job.at);
  if (lateMs < 0) return { due: false };
  const lateSec = Math.floor(lateMs / 1000);
  return { due: true, lateSec, withinGrace: lateSec <= job.graceSec };
}

/** Keep every pending job; cap the finished history so the file does not grow forever. */
export function pruneOnce(jobs: OnceJob[]): OnceJob[] {
  const pending = jobs.filter((j) => j.status === "pending");
  const done = jobs.filter((j) => j.status !== "pending").sort((a, b) => (a.firedAt ?? a.at).localeCompare(b.firedAt ?? b.at));
  return [...pending, ...done.slice(-MAX_FINISHED)];
}

export function matchOnce(jobs: OnceJob[], ref: string): OnceJob | undefined {
  const r = ref.trim();
  if (!r) return undefined;
  const hex = r.startsWith("once:") ? r.slice(5) : r;
  return jobs.find((j) => j.id === r) ?? jobs.find((j) => j.id === `once:${r}`) ?? (hex.length >= 4 ? jobs.find((j) => j.id.startsWith(`once:${hex}`)) : undefined) ?? jobs.find((j) => j.title === r);
}

export function describeOnce(job: OnceJob): string {
  return `once ${job.at.replace(/\.\d{3}Z$/, "Z")}`;
}

/** Exclusive tick lock; a lock older than 10 minutes is considered stale and stolen. */
export function acquireOnceLock(): (() => void) | null {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    if (existsSync(ONCE_LOCK_PATH) && Date.now() - statSync(ONCE_LOCK_PATH).mtimeMs > 10 * 60_000) unlinkSync(ONCE_LOCK_PATH);
    const fd = openSync(ONCE_LOCK_PATH, "wx"); writeFileSync(fd, String(process.pid)); closeSync(fd);
    return () => { try { unlinkSync(ONCE_LOCK_PATH); } catch { /* ignore */ } };
  } catch { return null; }
}
