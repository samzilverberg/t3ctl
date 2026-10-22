/**
 * Thread operations shared by the `threads` commands and the scheduler: create a thread (optionally
 * starting its first turn) and start a follow-up turn on an existing thread.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { withAuthRetry, type Ctx, type GlobalOpts } from "./context.js";
import { api, dispatch, launchThread, type ShellProject, type ShellThread } from "./http.js";
import { buildModelSelection, fetchConfig, fetchProviders, resolveModel, type ModelSelection, type ServerConfig } from "./models.js";
import { tempBranchName, uuid } from "./ids.js";
import { readConfig } from "./config.js";
import { parseWhen } from "./time.js";
import { threadStatus } from "./wait.js";
import { short } from "./output.js";
import { checkRate, enforceGuard, guardConfig, MAX_BATCH, MIN_BATCH, normalize } from "./guard.js";
import { CliError } from "./errors.js";

export const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];
export const INTERACTION_MODES = ["default", "plan"] as const;
export type InteractionMode = (typeof INTERACTION_MODES)[number];

export interface NewThreadOpts {
  project: string;
  text: string;
  model?: string;
  effort?: string;
  contextWindow?: string;
  fast?: boolean;
  title?: string;
  env?: string;
  base?: string;
  branch?: string;
  runtimeMode?: RuntimeMode;
  interactionMode?: InteractionMode;
  draft?: boolean;
  snooze?: string;
}

export interface NewThreadSummary {
  threadId: string; projectId: string; project: string; title: string; modelSelection: ModelSelection;
  runtimeMode: RuntimeMode; interactionMode: InteractionMode; env: string; branch: string | null; baseBranch: string | null;
  draft: boolean; snoozedUntil: string | null; sequence: number | null; url: string;
}

export function matchThread(threads: ShellThread[], ref: string): ShellThread {
  // An empty ref would prefix-match everything (an unset "$VAR" must not pick the first thread).
  if (!ref.trim()) throw new CliError("thread_not_found", "empty thread ref", { ref });
  const t = threads.find((x) => x.id === ref) ?? threads.find((x) => x.id.startsWith(ref)) ?? threads.find((x) => x.title === ref);
  if (!t) throw new CliError("thread_not_found", `thread not found: ${ref}`, { ref });
  return t;
}
/** id, id prefix, exact title, or workspace root (a path: contains `/`, or is `.` / `..`; relative to cwd). */
export function matchProject(projects: ShellProject[], ref: string): ShellProject {
  if (!ref.trim()) throw new CliError("project_not_found", `empty project ref. Known: ${projects.map((x) => x.title).join(", ")}`, { ref, known: projects.map((x) => x.title) });
  const path = ref.includes("/") || ref === "." || ref === ".." ? resolve(ref) : undefined;
  const p = projects.find((x) => x.id === ref) ?? projects.find((x) => x.id.startsWith(ref)) ?? projects.find((x) => x.title === ref)
    ?? (path ? projects.find((x) => x.workspaceRoot === path) : undefined);
  if (!p) throw new CliError("project_not_found", `project not found: ${ref}. Known: ${projects.map((x) => x.title).join(", ")}`, { ref, known: projects.map((x) => x.title) });
  return p;
}

function gitCurrentBranch(cwd: string): string | undefined {
  try { return execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; } catch { return undefined; }
}

/** Apply config `defaults` and validate modes. Exported so callers can validate early (scheduler `add`). */
export function applyDefaults<T extends Pick<NewThreadOpts, "runtimeMode" | "interactionMode" | "model" | "effort" | "env">>(o: T): T & { runtimeMode: RuntimeMode; interactionMode: InteractionMode } {
  const d = readConfig().defaults ?? {};
  const runtimeMode = o.runtimeMode ?? (d.runtimeMode as RuntimeMode | undefined) ?? "auto";
  const interactionMode = o.interactionMode ?? (d.interactionMode as InteractionMode | undefined) ?? "default";
  if (!RUNTIME_MODES.includes(runtimeMode)) throw new CliError("invalid_option", `invalid --runtime-mode. Allowed: ${RUNTIME_MODES.join(", ")}`, { option: "runtimeMode", allowed: RUNTIME_MODES });
  if (!INTERACTION_MODES.includes(interactionMode)) throw new CliError("invalid_option", `invalid --interaction-mode. Allowed: ${INTERACTION_MODES.join(", ")}`, { option: "interactionMode", allowed: INTERACTION_MODES });
  return { ...o, runtimeMode, interactionMode, model: o.model ?? d.model, effort: o.effort ?? d.effort, env: o.env ?? d.env };
}

/** `--env` value → worktree|local (default: project override, else server setting, else worktree). */
export function envModeOf(env: string | undefined, settings: Record<string, unknown>, projectDefault?: string | null): "worktree" | "local" {
  const mode = (env ?? projectDefault ?? (settings.defaultThreadEnvMode as string | undefined) ?? "worktree").toLowerCase();
  if (mode !== "worktree" && mode !== "local") throw new CliError("invalid_option", "--env must be worktree|local", { option: "env", allowed: ["worktree", "local"] });
  return mode;
}

/** Resolve the model selection for a new thread: explicit flags → project default → server default. */
export async function resolveNewModel(ctx: Ctx, project: ShellProject, o: Pick<NewThreadOpts, "model" | "effort" | "contextWindow" | "fast">, config?: ServerConfig): Promise<{ modelSelection: ModelSelection; settings: Record<string, unknown> }> {
  const { providers, settings } = config ?? await fetchConfig(ctx.server, ctx.client.token);
  const fallback = (project.defaultModelSelection as ModelSelection | undefined) ?? (settings.textGenerationModelSelection as ModelSelection | undefined);
  if (o.model || o.effort || o.contextWindow || o.fast !== undefined) {
    const ref = o.model ?? (fallback ? `${fallback.instanceId}/${fallback.model}` : undefined);
    if (!ref) throw new Error("no model given and no default model found; pass --model");
    const resolved = resolveModel(providers, ref);
    // Start from fallback options when user only overrides some knobs on the same model.
    const base = fallback && fallback.model === resolved.model.slug ? Object.fromEntries((fallback.options ?? []).map((x) => [x.id, x.value])) : {};
    return {
      settings,
      modelSelection: buildModelSelection(resolved, {
        effort: o.effort ?? (typeof base.effort === "string" ? base.effort : undefined),
        contextWindow: o.contextWindow ?? (typeof base.contextWindow === "string" ? base.contextWindow : undefined),
        fast: o.fast ?? (typeof base.fastMode === "boolean" ? base.fastMode : undefined),
      }),
    };
  }
  if (fallback) return { modelSelection: fallback, settings };
  throw new Error("no default model configured; pass --model");
}

/**
 * Create a thread; unless `draft`, also start its first turn with `text`. `guard` runs the duplicate / rate-limit
 * check (src/guard.ts) first; `threads new` enables it, the scheduler does not. `config` reuses an already fetched
 * `server.getConfig` (batch).
 */
export async function createThread(ctx: Ctx, g: GlobalOpts, input: NewThreadOpts, { guard = false, config }: { guard?: boolean; config?: ServerConfig } = {}): Promise<NewThreadSummary> {
  const o = applyDefaults(input);
  const { runtimeMode, interactionMode } = o;
  const draft = o.draft === true;
  const text = o.text;
  if (!draft && !text) throw new Error("missing prompt");
  if (draft && !o.title && !text) throw new Error("--draft needs -t <title> (or a prompt to derive it from)");
  const snoozedUntil = o.snooze ? parseWhen(o.snooze) : undefined;
  const shell = await withAuthRetry(ctx, g, api.shell);
  const project = matchProject(shell.projects, o.project);
  const title = (o.title ?? text.split("\n")[0]).trim().slice(0, 80) || "Untitled";
  if (guard) await enforceGuard(ctx.client, shell.threads, project, { title, text });
  const { modelSelection, settings } = await resolveNewModel(ctx, project, o, config);

  const envMode = envModeOf(o.env, settings, project.defaultThreadEnvMode);
  const currentBranch = gitCurrentBranch(project.workspaceRoot);
  // Worktree threads need a base ref (the checkout's current branch unless --base). A detached HEAD or a non-git
  // root cannot be the base, so they fall back to the project root ("local").
  const useWorktree = envMode === "worktree" && Boolean(o.base ?? currentBranch) && currentBranch !== "HEAD";
  const baseBranch = o.base ?? currentBranch;
  const worktreeBranch = o.branch ?? tempBranchName();
  const startFromOrigin = settings.newWorktreesStartFromOrigin === true;
  const workspaceStrategy = useWorktree
    ? { type: "worktree", baseRef: baseBranch!, branch: worktreeBranch, ...(startFromOrigin ? { startFromOrigin: true } : {}) }
    : { type: "root", ...(currentBranch && currentBranch !== "HEAD" ? { branch: currentBranch } : {}) };

  const threadId = uuid();
  let sequence: number | null = null;
  if (draft) {
    // A draft is a bare thread row: no run, so no workspace preparation either.
    const res = await withAuthRetry(ctx, g, (c) => dispatch(c, { type: "thread.create", commandId: uuid(), threadId, projectId: project.id, title, modelSelection, runtimeMode, interactionMode, branch: currentBranch && currentBranch !== "HEAD" ? currentBranch : null, worktreePath: null, createdBy: "user", creationSource: "server" }));
    sequence = res.sequence;
  } else {
    // launchThread = create + prepare workspace (worktree, setup script) + first run, atomically on the server.
    await withAuthRetry(ctx, g, (c) => launchThread(c, { commandId: uuid(), threadId, projectId: project.id, title, modelSelection, runtimeMode, interactionMode, workspaceStrategy, creationSource: "server", initialMessage: { messageId: uuid(), text, attachments: [] } }));
  }
  if (snoozedUntil) {
    // The decider rejects snoozing a thread whose run is still being prepared/queued.
    if (!draft) await waitForRunStarted(ctx, threadId, 60_000);
    await dispatch(ctx.client, { type: "thread.snooze", commandId: uuid(), threadId, snoozedUntil });
  }
  return {
    threadId, projectId: project.id, project: project.title, title, modelSelection, runtimeMode, interactionMode,
    env: useWorktree ? "worktree" : "local", branch: useWorktree ? worktreeBranch : (currentBranch ?? null),
    baseBranch: useWorktree ? (baseBranch ?? null) : null, draft, snoozedUntil: snoozedUntil ?? null, sequence, url: `${ctx.server.origin}/thread/${threadId}`,
  };
}

/** One entry of `threads new --batch`; everything else comes from the shared flags. */
export interface BatchItem { text: string; title?: string; model?: string; effort?: string; branch?: string }
const BATCH_KEYS = ["prompt", "title", "model", "effort", "branch"] as const;

/** Parse `--batch` input: a JSON array of prompt strings or `{prompt, title?, model?, effort?, branch?}` objects. */
export function parseBatch(raw: string): BatchItem[] {
  let v: unknown;
  try { v = JSON.parse(raw); } catch (e) { throw new Error(`--batch: invalid JSON (${(e as Error).message})`); }
  if (!Array.isArray(v)) throw new Error("--batch: expected a JSON array of prompt strings or {prompt, title?, model?, effort?, branch?} objects");
  checkBatchSize(v.length);
  return v.map((x, i): BatchItem => {
    if (typeof x === "string") return { text: x };
    if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error(`--batch[${i}]: expected a string or an object`);
    const o = x as Record<string, unknown>;
    const unknown = Object.keys(o).filter((k) => !(BATCH_KEYS as readonly string[]).includes(k));
    if (unknown.length) throw new Error(`--batch[${i}]: unknown key(s) ${unknown.join(", ")}. Allowed: ${BATCH_KEYS.join(", ")}`);
    const bad = BATCH_KEYS.filter((k) => o[k] !== undefined && typeof o[k] !== "string");
    if (bad.length) throw new Error(`--batch[${i}]: ${bad.join(", ")} must be string(s)`);
    const { prompt, title, model, effort, branch } = o as Record<string, string | undefined>;
    return { text: prompt ?? "", title, model, effort, branch };
  });
}

/** A batch is 2..MAX_BATCH threads: one thread is a plain `threads new` (and goes through the duplicate check). */
function checkBatchSize(n: number): void {
  if (n < MIN_BATCH || n > MAX_BATCH) throw new CliError("invalid_batch", `--batch: ${MIN_BATCH}..${MAX_BATCH} threads per call (got ${n}); for one thread use plain \`threads new\``, { count: n, min: MIN_BATCH, max: MAX_BATCH });
}

/**
 * Create 2..MAX_BATCH threads in one call, sequentially. Skips the duplicate check against recent threads by
 * intent (the caller asked for several related threads) but rejects items that repeat each other verbatim, and
 * still applies the rate limit for the whole batch. Every item's model/effort is validated before anything is
 * created, so a typo cannot leave half a batch behind.
 */
export async function createThreads(ctx: Ctx, g: GlobalOpts, base: Omit<NewThreadOpts, "text" | "title" | "branch">, items: BatchItem[]): Promise<NewThreadSummary[]> {
  checkBatchSize(items.length);
  const bad = (i: number, msg: string) => new CliError("invalid_batch", `--batch[${i}]: ${msg}`, { index: i });
  const seen = new Map<string, number>();
  items.forEach((it, i) => {
    if (!base.draft && !it.text.trim()) throw bad(i, "missing prompt");
    if (base.draft && !it.text.trim() && !it.title) throw bad(i, "--draft needs a title or prompt");
    const key = normalize(it.text) || `title:${normalize(it.title ?? "")}`;
    if (seen.has(key)) throw bad(i, `same ${it.text.trim() ? "prompt" : "title"} as item ${seen.get(key)}`);
    seen.set(key, i);
  });
  const branches = items.map((it) => it.branch).filter(Boolean);
  if (new Set(branches).size !== branches.length) throw new CliError("invalid_batch", "--batch: branch names must be unique");
  const shell = await withAuthRetry(ctx, g, api.shell);
  const project = matchProject(shell.projects, base.project);
  checkRate(shell.threads, project.id, project.title, items.length, new Date(), guardConfig());
  const config = await fetchConfig(ctx.server, ctx.client.token);
  const inputs = items.map((it): NewThreadOpts => ({ ...base, text: it.text, title: it.title, branch: it.branch, model: it.model ?? base.model, effort: it.effort ?? base.effort }));
  for (const [i, input] of inputs.entries()) {
    try { await resolveNewModel(ctx, project, applyDefaults(input), config); } catch (e) {
      if (e instanceof CliError) throw new CliError(e.code, `--batch[${i}]: ${e.message}`, { ...e.details, index: i });
      throw bad(i, e instanceof Error ? e.message : String(e));
    }
  }
  const created: NewThreadSummary[] = [];
  for (const [i, input] of inputs.entries()) {
    try {
      created.push(await createThread(ctx, g, input, { config }));
    } catch (e) {
      if (created.length === 0) throw e;
      const cause = e instanceof Error ? e.message : String(e);
      throw new CliError("batch_partial", `batch stopped at item ${i}: ${cause}. Already created: ${created.map((c) => short(c.threadId)).join(", ")}`, { created, failedIndex: i, cause });
    }
  }
  return created;
}

export interface SendOpts { text: string; model?: string; effort?: string; runtimeMode?: RuntimeMode; interactionMode?: InteractionMode; /** What to do when a run is active: refuse (default), queue after it, or steer it. */ whenRunning?: "refuse" | "queue" | "steer" }

/** Model for a follow-up turn: the thread's own, or `model`/`effort` overrides validated against the catalog. */
export async function resolveTurnModel(ctx: Ctx, t: ShellThread, o: Pick<SendOpts, "model" | "effort">): Promise<ModelSelection | undefined> {
  const current = t.modelSelection as ModelSelection | undefined;
  if (!o.model && !o.effort) return undefined;
  const providers = await fetchProviders(ctx.server, ctx.client.token);
  const resolved = resolveModel(providers, o.model ?? `${current?.instanceId}/${current?.model}`);
  const baseEffort = (current?.options ?? []).find((x) => x.id === "effort")?.value;
  return buildModelSelection(resolved, { effort: o.effort ?? (typeof baseEffort === "string" ? baseEffort : undefined) });
}

/**
 * Send a message to an existing, non-archived thread (`message.dispatch`). Idle thread → `start_immediately`.
 * Running thread → refused unless `whenRunning` is `queue` (runs after the active run) or `steer` (injected into it).
 */
export async function startTurn(ctx: Ctx, g: GlobalOpts, t: ShellThread, o: SendOpts): Promise<{ threadId: string; sequence: number; dispatchMode: string }> {
  const status = threadStatus(t);
  if (t.archivedAt) throw new CliError("thread_archived", `thread ${short(t.id)} is archived`, { threadId: t.id });
  const running = status === "running" || status === "needs-approval" || status === "needs-input";
  let dispatchMode: Record<string, unknown> = { type: "start_immediately" };
  if (running) {
    const when = o.whenRunning ?? "refuse";
    if (when === "refuse") throw new CliError("thread_running", `thread ${short(t.id)} is ${status}; wait for it, or pass --queue / --steer`, { threadId: t.id, status });
    if (when === "steer" && !t.activeRunId) throw new CliError("thread_running", `thread ${short(t.id)} has no active run to steer`, { threadId: t.id, status });
    dispatchMode = when === "queue" ? { type: "queue_after_active" } : { type: "steer_active", targetRunId: t.activeRunId };
  }
  const modelSelection = await resolveTurnModel(ctx, t, o);
  const command = {
    type: "message.dispatch",
    commandId: uuid(),
    threadId: t.id,
    messageId: uuid(),
    text: o.text,
    attachments: [],
    createdBy: "user",
    creationSource: "server",
    ...(modelSelection ? { modelSelection } : {}),
    dispatchMode,
  };
  // runtimeMode / interactionMode are thread settings now, not per-message: apply overrides as separate commands first.
  if (o.runtimeMode && o.runtimeMode !== t.runtimeMode) await withAuthRetry(ctx, g, (c) => dispatch(c, { type: "thread.runtime-mode.set", commandId: uuid(), threadId: t.id, runtimeMode: o.runtimeMode }));
  if (o.interactionMode && o.interactionMode !== t.interactionMode) await withAuthRetry(ctx, g, (c) => dispatch(c, { type: "thread.interaction-mode.set", commandId: uuid(), threadId: t.id, interactionMode: o.interactionMode }));
  const res = await withAuthRetry(ctx, g, (c) => dispatch(c, command));
  return { threadId: t.id, sequence: res.sequence, dispatchMode: String(dispatchMode.type) };
}

/** Poll until the thread's run has left the preparing/queued phase (or finished). */
export async function waitForRunStarted(ctx: Ctx, threadId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = (await api.shell(ctx.client)).threads.find((x) => x.id === threadId);
    if (t && t.status !== undefined && t.status !== "preparing" && t.status !== "queued") return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("timed out waiting for the run to start; thread created but not snoozed");
}

export function effortOf(ms?: { options?: Array<{ id: string; value: unknown }> }): string | undefined {
  const v = ms?.options?.find((o) => o.id === "effort")?.value;
  return typeof v === "string" ? v : undefined;
}
