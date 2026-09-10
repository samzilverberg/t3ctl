/**
 * Client-side scheduler. T3 has no deferred start (snooze is visibility only), so jobs live in
 * ~/.config/t3ctl/schedule.json and a launchd ticker runs `t3ctl schedule tick` every minute.
 *
 * Rules (fixed, not configurable, to keep the surface small):
 *  - A job fires at most once per occurrence; missed occurrences are never replayed.
 *  - Late fire is allowed only within the grace window (default 60m, or half the cron interval if smaller).
 *  - Recurring jobs skip an occurrence while the thread of the previous run is still running / waiting on a human.
 *  - One-shots are kept in the file after firing (visible with `list -a`), recurring jobs keep their last 30 runs.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Cron } from "croner";
import { CONFIG_DIR } from "./config.js";
import { parseWhen } from "./time.js";
import type { RuntimeMode, InteractionMode } from "./ops.js";

export const SCHEDULE_PATH = join(CONFIG_DIR, "schedule.json");
export const LOCK_PATH = join(CONFIG_DIR, "schedule.lock");
export const LOG_PATH = join(CONFIG_DIR, "scheduler.log");

export interface Run { at: string; firedAt: string; status: "fired" | "skipped" | "failed"; threadId?: string; sequence?: number; reason?: string }

export interface Job {
  id: string;
  createdAt: string;
  /** Cron expression for recurring jobs; absent for one-shots. */
  cron?: string;
  /** Next scheduled occurrence (ISO). null when a one-shot has fired/skipped. */
  nextAt: string | null;
  graceSec: number;
  /** New thread per occurrence … */
  new?: { project: string; text: string; model?: string; effort?: string; title?: string; env?: string; runtimeMode?: RuntimeMode; interactionMode?: InteractionMode };
  /** … or a follow-up turn on an existing thread. */
  send?: { thread: string; text: string; model?: string; effort?: string };
  runs: Run[];
}

interface Store { jobs: Job[] }

const MAX_RUNS = 30;

export function readStore(): Store {
  try { return JSON.parse(readFileSync(SCHEDULE_PATH, "utf8")) as Store; } catch { return { jobs: [] }; }
}
export function writeStore(s: Store): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${SCHEDULE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, SCHEDULE_PATH);
}

export const newJobId = () => randomBytes(4).toString("hex");

/** Parse a duration like 30m / 2h / 1d into seconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+)\s*(s|m|min|h|hr|d)?$/.exec(s.trim().toLowerCase());
  if (!m) throw new Error(`cannot parse duration "${s}" (use 30m, 2h, 1d)`);
  const n = Number(m[1]); const u = (m[2] ?? "m")[0];
  return n * (u === "s" ? 1 : u === "m" ? 60 : u === "h" ? 3600 : 86400);
}

function isCron(s: string): boolean {
  const t = s.trim();
  return t.startsWith("@") || t.split(/\s+/).length >= 5;
}

function cronOf(expr: string): Cron {
  try { return new Cron(expr); } catch (e) { throw new Error(`invalid cron "${expr}": ${(e as Error).message}`); }
}

/** Interpret `<when>`: cron / @daily → recurring; otherwise a one-shot via parseWhen. */
export function parseSchedule(when: string, now = new Date()): { cron?: string; nextAt: string; defaultGraceSec: number } {
  if (isCron(when)) {
    const c = cronOf(when);
    const n1 = c.nextRun(now); const n2 = n1 ? c.nextRun(n1) : null;
    if (!n1) throw new Error(`cron "${when}" never fires`);
    const intervalSec = n2 ? (n2.getTime() - n1.getTime()) / 1000 : 3600;
    return { cron: when.trim(), nextAt: n1.toISOString(), defaultGraceSec: Math.max(60, Math.min(3600, Math.floor(intervalSec / 2))) };
  }
  const nextAt = parseWhen(when, now);
  if (Date.parse(nextAt) <= now.getTime()) throw new Error(`"${when}" is in the past`);
  return { nextAt, defaultGraceSec: 3600 };
}

/**
 * Decide what a job should do now. Returns the occurrence to act on (the most recent one due, never more than
 * one), whether it is inside grace, and the job's next occurrence after this one.
 */
export function evaluate(job: Job, now = new Date()): { due: false } | { due: true; at: string; late: boolean; missed: number; nextAt: string | null } {
  if (!job.nextAt) return { due: false };
  let next = new Date(job.nextAt);
  if (next.getTime() > now.getTime()) return { due: false };
  if (!job.cron) return { due: true, at: job.nextAt, late: now.getTime() - next.getTime() > job.graceSec * 1000, missed: 0, nextAt: null };
  const c = cronOf(job.cron);
  let last = next; let missed = -1;
  while (next.getTime() <= now.getTime()) { last = next; missed++; const n = c.nextRun(next); if (!n) break; next = n; }
  const following = next.getTime() > now.getTime() ? next.toISOString() : null;
  return { due: true, at: last.toISOString(), late: now.getTime() - last.getTime() > job.graceSec * 1000, missed, nextAt: following };
}

export function recordRun(job: Job, run: Run): void {
  job.runs.push(run);
  if (job.runs.length > MAX_RUNS) job.runs.splice(0, job.runs.length - MAX_RUNS);
}

/** Exclusive tick lock; a lock older than 10 minutes is considered stale and stolen. */
export function acquireLock(): (() => void) | null {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    if (existsSync(LOCK_PATH) && Date.now() - statSync(LOCK_PATH).mtimeMs > 10 * 60_000) unlinkSync(LOCK_PATH);
    const fd = openSync(LOCK_PATH, "wx"); writeFileSync(fd, String(process.pid)); closeSync(fd);
    return () => { try { unlinkSync(LOCK_PATH); } catch { /* ignore */ } };
  } catch { return null; }
}

export function describeWhen(job: Job): string {
  return job.cron ?? (job.nextAt ?? job.runs.at(-1)?.at ?? "");
}
