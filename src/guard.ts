/**
 * Duplicate / spam guard for `threads new`. Callers (usually agents) sometimes fire the same `threads new` twice
 * within seconds (e.g. after a double-submitted user message) and end up with two threads doing the same work.
 * Before creating, look at the threads the server already has in the same project:
 *  - duplicate: one created within `windowSec` whose first prompt (or, when either side has no prompt, title)
 *    is at least `similarity` alike (Dice coefficient over character trigrams of the normalized text)
 *  - rate limit: `rateMax` threads already created in the project within `rateWindowSec`
 * Best effort by design: two calls racing inside the same second can both pass. `--force` skips both checks;
 * the scheduler never runs them. Thresholds are tunable via config.json `guard`.
 */
import { readConfig } from "./config.js";
import { CliError } from "./errors.js";
import { api, type Client, type ShellThread } from "./http.js";
import { short } from "./output.js";

export interface GuardConfig {
  /** Seconds a thread counts as "just created" for the duplicate check. 0 disables it. */
  windowSec: number;
  /** 0..1 similarity at or above which a recent thread counts as a duplicate. */
  similarity: number;
  /** Max threads created per project within `rateWindowSec` (including the ones being created). 0 disables it. */
  rateMax: number;
  rateWindowSec: number;
}

export const GUARD_DEFAULTS: GuardConfig = { windowSec: 60, similarity: 0.8, rateMax: 5, rateWindowSec: 60 };
/** Upper bound on threads per `threads new --batch` call. Not configurable. */
export const MAX_BATCH = 5;
/** Exit code for a create refused by the guard (duplicate or rate limit). */
export const GUARD_EXIT = 6;

export function guardConfig(): GuardConfig {
  return { ...GUARD_DEFAULTS, ...(readConfig().guard ?? {}) };
}

export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function trigrams(s: string): Set<string> {
  const t = ` ${s} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

/** Sørensen–Dice over character trigrams of the normalized strings: 1 = same text, ~0 = unrelated. */
export function similarity(a: string, b: string): number {
  const x = normalize(a), y = normalize(b);
  if (x === y) return 1;
  if (!x || !y) return 0;
  const A = trigrams(x), B = trigrams(y);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

export interface Candidate { thread: ShellThread; prompt?: string }
export interface DuplicateMatch { threadId: string; title: string; createdAt: string; secondsAgo: number; similarity: number; matchedOn: "prompt" | "title" }

const ageSec = (t: ShellThread, now: Date) => (now.getTime() - Date.parse(t.createdAt ?? "")) / 1000;

/** Threads in `projectId` created within `windowSec` of `now`, newest first. */
export function recentThreads(threads: ShellThread[], projectId: string, windowSec: number, now: Date): ShellThread[] {
  return threads
    .filter((t) => t.projectId === projectId && !t.archivedAt && ageSec(t, now) <= windowSec)
    .sort((a, b) => ageSec(a, now) - ageSec(b, now));
}

/** Most similar recent candidate at or above the threshold. Compares prompts when both sides have one, else titles. */
export function findDuplicate(candidates: Candidate[], next: { title: string; text: string }, now: Date, cfg: GuardConfig): DuplicateMatch | undefined {
  let best: DuplicateMatch | undefined;
  for (const c of candidates) {
    const onPrompt = Boolean(c.prompt && next.text);
    const score = onPrompt ? similarity(c.prompt!, next.text) : similarity(c.thread.title, next.title);
    if (score < cfg.similarity || (best && best.similarity >= score)) continue;
    best = {
      threadId: c.thread.id, title: c.thread.title, createdAt: c.thread.createdAt ?? "",
      secondsAgo: Math.max(0, Math.round(ageSec(c.thread, now))), similarity: Math.round(score * 100) / 100, matchedOn: onPrompt ? "prompt" : "title",
    };
  }
  return best;
}

export function duplicateError(project: string, d: DuplicateMatch): CliError {
  return new CliError(
    "duplicate_thread",
    `a very similar thread ${short(d.threadId)} "${d.title}" was created ${d.secondsAgo}s ago in project ${project} ` +
      `(${d.matchedOn} ${Math.round(d.similarity * 100)}% alike). Check whether you already created a thread for this task; ` +
      `pass --force to create anyway (or --batch to create several related threads at once).`,
    { project, duplicate: d, hint: "pass --force to create anyway" },
    GUARD_EXIT,
  );
}

/** Throws `rate_limited` when creating `n` more threads would exceed `rateMax` within `rateWindowSec`. */
export function checkRate(threads: ShellThread[], projectId: string, project: string, n: number, now: Date, cfg: GuardConfig): void {
  if (cfg.rateMax <= 0) return;
  const recent = recentThreads(threads, projectId, cfg.rateWindowSec, now);
  const excess = recent.length + n - cfg.rateMax;
  if (excess <= 0) return;
  // Room frees up when the `excess` oldest recent threads fall out of the window (never, if n alone exceeds the max).
  const oldest = recent[recent.length - excess];
  const retryAfterSec = oldest ? Math.max(1, Math.ceil(cfg.rateWindowSec - ageSec(oldest, now))) : null;
  throw new CliError(
    "rate_limited",
    `${recent.length} thread(s) were already created in project ${project} in the last ${cfg.rateWindowSec}s ` +
      `(limit ${cfg.rateMax}${n > 1 ? `, this call adds ${n}` : ""}). Check that you are not creating threads in a loop` +
      `${retryAfterSec ? `; retry in ${retryAfterSec}s` : ""} or pass --force.`,
    {
      project, limit: { max: cfg.rateMax, windowSec: cfg.rateWindowSec }, requested: n, retryAfterSec,
      recent: recent.map((t) => ({ threadId: t.id, title: t.title, createdAt: t.createdAt, secondsAgo: Math.max(0, Math.round(ageSec(t, now))) })),
      hint: "pass --force to create anyway",
    },
    GUARD_EXIT,
  );
}

async function firstPrompt(client: Client, threadId: string): Promise<string | undefined> {
  try {
    const d = await api.thread(client, threadId);
    const m = ((d.thread.messages ?? []) as Array<{ role?: unknown; text?: unknown }>).find((x) => x.role === "user");
    return typeof m?.text === "string" ? m.text : undefined;
  } catch { return undefined; }
}

/**
 * Guard for a single `threads new`: duplicate check, then rate limit. Only threads inside the window get their
 * detail fetched (usually none), so the happy path costs nothing beyond the shell snapshot createThread already has.
 */
export async function enforceGuard(client: Client, threads: ShellThread[], project: { id: string; title: string }, next: { title: string; text: string }, cfg = guardConfig(), now = new Date()): Promise<void> {
  if (cfg.windowSec > 0) {
    const recent = recentThreads(threads, project.id, cfg.windowSec, now);
    const candidates = await Promise.all(recent.map(async (thread) => ({ thread, prompt: next.text ? await firstPrompt(client, thread.id) : undefined })));
    const dup = findDuplicate(candidates, next, now, cfg);
    if (dup) throw duplicateError(project.title, dup);
  }
  checkRate(threads, project.id, project.title, 1, now, cfg);
}
