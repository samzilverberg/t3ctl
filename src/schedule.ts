/**
 * `t3ctl schedule` is a thin client of T3 Code's own scheduler (0.1+): tasks live in the app's SQLite and are
 * fired by the server (`scheduledTasks.*` RPCs, the same backend the desktop UI and the MCP `schedule_task` tool
 * use). This module holds the pure parts: schedule parsing/rendering, cron → T3 schedule conversion, and reading
 * the legacy client-side job file that pre-0.5 t3ctl kept for its launchd ticker (for `schedule migrate`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./config.js";
import { CliError } from "./errors.js";

export type Schedule =
  | { type: "interval"; everyMs: number }
  | { type: "fixed_time"; timeOfDay: string; weekdays?: number[] }
  | { type: "webhook"; signature: null | Record<string, unknown>; [k: string]: unknown };

/** `ScheduledTask` as returned by `scheduledTasks.list` (fields we render; the rest passes through). */
export interface ScheduledTask {
  id: string;
  title: string;
  prompt: string;
  enabled: boolean;
  schedule: Schedule;
  projectId: string;
  threadId: string | null;
  workspaceStrategy: Record<string, unknown>;
  modelSelection: { instanceId: string; model: string; options?: Array<{ id: string; value: string | boolean }> };
  runtimeMode: string;
  interactionMode: string;
  createdBy: string;
  creationSource: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: "never" | "running" | "succeeded" | "failed" | string;
  lastRunError: string | null;
  runCount: number;
  webhook?: { path: string; url: string | null; hasSecret: boolean };
  [k: string]: unknown;
}

export const MIN_INTERVAL_MS = 60_000;

/** Parse a duration like 30m / 2h / 1d into seconds (bare number = minutes). */
export function parseDuration(s: string): number {
  const m = /^(\d+)\s*(s|m|min|h|hr|d)?$/.exec(s.trim().toLowerCase());
  if (!m) throw new CliError("invalid_option", `cannot parse duration "${s}" (use 30m, 2h, 1d)`, { input: s });
  const n = Number(m[1]); const u = (m[2] ?? "m")[0];
  return n * (u === "s" ? 1 : u === "m" ? 60 : u === "h" ? 3600 : 86400);
}

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const dayIndex = (s: string): number => {
  const t = s.trim().toLowerCase();
  if (/^\d$/.test(t)) { const n = Number(t); if (n <= 7) return n % 7; }
  const i = DAY_NAMES.findIndex((d) => t.startsWith(d));
  if (i < 0) throw new CliError("invalid_option", `unknown weekday "${s}" (use mon..sun or 0..6, 0 = Sunday)`, { input: s });
  return i;
};

/** `mon-fri`, `1-5`, `mon,wed,fri`, `weekdays`, `weekends`, `daily`/`*` → sorted weekday numbers (undefined = every day). */
export function parseWeekdays(spec: string): number[] | undefined {
  const s = spec.trim().toLowerCase();
  if (s === "" || s === "*" || s === "daily" || s === "every" || s === "all") return undefined;
  if (s === "weekdays") return [1, 2, 3, 4, 5];
  if (s === "weekends") return [0, 6];
  const out = new Set<number>();
  for (const part of s.split(",")) {
    const range = /^([^-]+)-([^-]+)$/.exec(part.trim());
    if (range) {
      const a = dayIndex(range[1]); const b = dayIndex(range[2]);
      for (let d = a; ; d = (d + 1) % 7) { out.add(d); if (d === b) break; }
    } else out.add(dayIndex(part));
  }
  const days = [...out].sort((a, b) => a - b);
  return days.length === 7 ? undefined : days;
}

export function parseTimeOfDay(s: string): string {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  if (!m) throw new CliError("invalid_option", `cannot parse time "${s}" (use HH:MM, 24-hour)`, { input: s });
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

export function intervalSchedule(dur: string): Schedule {
  const everyMs = parseDuration(dur) * 1000;
  if (everyMs < MIN_INTERVAL_MS) throw new CliError("invalid_option", `interval must be at least 1m (got ${dur})`, { input: dur, minMs: MIN_INTERVAL_MS });
  return { type: "interval", everyMs };
}

export function fixedTimeSchedule(time: string, days?: string): Schedule {
  const weekdays = days === undefined ? undefined : parseWeekdays(days);
  return { type: "fixed_time", timeOfDay: parseTimeOfDay(time), ...(weekdays ? { weekdays } : {}) };
}

/**
 * Translate the subset of cron that T3 Code's scheduler can express:
 *   `@hourly` / `@daily` / `@weekly` / `@weekdays`, `*\/N * * * *` and `0 *\/N * * *` → interval,
 *   `M H * * D` → fixed daily time at H:M on weekdays D.
 * Anything else (several hours, day-of-month, months, sub-minute) throws `cron_not_expressible`.
 */
export function cronToSchedule(expr: string): Schedule {
  const e = expr.trim().toLowerCase();
  const no = (why: string) => new CliError("cron_not_expressible", `cron "${expr}" cannot be expressed as a T3 Code schedule (${why}). T3 schedules are: every N minutes/hours, or a fixed daily time with optional weekdays.`, { cron: expr, reason: why });
  if (e === "@hourly") return { type: "interval", everyMs: 3_600_000 };
  if (e === "@daily" || e === "@midnight") return { type: "fixed_time", timeOfDay: "00:00" };
  if (e === "@weekly") return { type: "fixed_time", timeOfDay: "00:00", weekdays: [0] };
  if (e === "@weekdays") return { type: "fixed_time", timeOfDay: "00:00", weekdays: [1, 2, 3, 4, 5] };
  if (e.startsWith("@")) throw no(`unsupported macro ${e}`);
  const f = e.split(/\s+/);
  if (f.length !== 5) throw no("expected 5 fields");
  const [min, hour, dom, mon, dow] = f;
  if (dom !== "*" || mon !== "*") throw no("day-of-month and month must be *");
  let m = /^\*\/(\d+)$/.exec(min);
  if (m && hour === "*" && dow === "*") return intervalSchedule(`${m[1]}m`);
  m = /^\*\/(\d+)$/.exec(hour);
  if (m && min === "0" && dow === "*") return intervalSchedule(`${m[1]}h`);
  if (min === "*" || hour === "*") throw no("every-minute / every-hour forms other than */N are not supported");
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour)) throw no("minute and hour must be single values");
  const weekdays = dow === "*" ? undefined : parseWeekdays(dow.replace(/7/g, "0"));
  return { type: "fixed_time", timeOfDay: parseTimeOfDay(`${hour}:${min.padStart(2, "0")}`), ...(weekdays ? { weekdays } : {}) };
}

export function describeSchedule(s: Schedule): string {
  if (s.type === "interval") {
    const sec = s.everyMs / 1000;
    return `every ${sec % 86400 === 0 ? `${sec / 86400}d` : sec % 3600 === 0 ? `${sec / 3600}h` : sec % 60 === 0 ? `${sec / 60}m` : `${sec}s`}`;
  }
  if (s.type === "fixed_time") {
    const days = s.weekdays === undefined ? "daily" : s.weekdays.length === 5 && s.weekdays.join() === "1,2,3,4,5" ? "weekdays" : s.weekdays.map((d) => DAY_NAMES[d]).join(",");
    return `${days} ${s.timeOfDay}`;
  }
  if (s.type === "webhook") return "webhook";
  return JSON.stringify(s);
}

export function matchTask(tasks: ScheduledTask[], ref: string): ScheduledTask {
  if (!ref.trim()) throw new CliError("task_not_found", "empty task ref", { ref });
  const t = tasks.find((x) => x.id === ref) ?? tasks.find((x) => x.id.startsWith(ref)) ?? tasks.find((x) => x.title === ref);
  if (!t) throw new CliError("task_not_found", `scheduled task not found: ${ref}`, { ref, known: tasks.map((x) => ({ id: x.id, title: x.title })) });
  return t;
}

// ---- Legacy client-side job file (t3ctl ≤ 0.4, launchd ticker) ----

export const LEGACY_SCHEDULE_PATH = join(CONFIG_DIR, "schedule.json");
export const LEGACY_LOG_PATH = join(CONFIG_DIR, "scheduler.log");

export interface LegacyJob {
  id: string;
  createdAt: string;
  cron?: string;
  tz?: string;
  nextAt: string | null;
  graceSec: number;
  new?: { project: string; projectTitle?: string; text: string; model?: string; effort?: string; title?: string; env?: string; runtimeMode?: string; interactionMode?: string };
  send?: { thread: string; text: string; model?: string; effort?: string };
  runs: Array<{ at: string; firedAt: string; status: string; threadId?: string; reason?: string }>;
}

export function readLegacyJobs(path = LEGACY_SCHEDULE_PATH): LegacyJob[] {
  try { return (JSON.parse(readFileSync(path, "utf8")) as { jobs?: LegacyJob[] }).jobs ?? []; } catch { return []; }
}

export type LegacyConversion =
  | { ok: true; job: LegacyJob; schedule: Schedule; title: string; prompt: string; note?: string }
  | { ok: false; job: LegacyJob; reason: string };

/** Pending recurring legacy jobs → T3 schedules. One-shots have no server equivalent and are reported as such. */
export function convertLegacyJob(job: LegacyJob): LegacyConversion {
  const prompt = job.new?.text ?? job.send?.text ?? "";
  const title = job.new?.title ?? prompt.split("\n")[0].slice(0, 80) ?? "Scheduled task";
  if (!job.nextAt) return { ok: false, job, reason: "already finished (one-shot that fired)" };
  if (!job.cron) return { ok: false, job, reason: `one-shot at ${job.nextAt}: T3 Code has no one-shot schedules (start it yourself with threads new, or use --at HH:MM and remove the task after it runs)` };
  try {
    const schedule = cronToSchedule(job.cron);
    return { ok: true, job, schedule, title, prompt, ...(job.tz && job.tz.toUpperCase() !== "UTC" ? { note: `was pinned to ${job.tz}; T3 Code fixed times are in the server's local time zone` } : job.tz ? { note: "was pinned to UTC; T3 Code fixed times are in the server's local time zone" } : {}) };
  } catch (e) {
    return { ok: false, job, reason: e instanceof Error ? e.message : String(e) };
  }
}
