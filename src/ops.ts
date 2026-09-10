/**
 * Thread operations shared by the `threads` commands and the scheduler: create a thread (optionally
 * starting its first turn) and start a follow-up turn on an existing thread.
 */
import { execFileSync } from "node:child_process";
import { withAuthRetry, type Ctx, type GlobalOpts } from "./context.js";
import { api, dispatch, type ShellProject, type ShellThread } from "./http.js";
import { buildModelSelection, fetchProviders, fetchServerSettings, resolveModel, type ModelSelection } from "./models.js";
import { nowIso, tempBranchName, uuid } from "./ids.js";
import { readConfig } from "./config.js";
import { parseWhen } from "./time.js";
import { threadStatus } from "./wait.js";
import { short } from "./output.js";

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
  setupScript?: boolean;
  draft?: boolean;
  snooze?: string;
}

export interface NewThreadSummary {
  threadId: string; projectId: string; project: string; title: string; modelSelection: ModelSelection;
  runtimeMode: RuntimeMode; interactionMode: InteractionMode; env: string; branch: string | null; baseBranch: string | null;
  draft: boolean; snoozedUntil: string | null; sequence: number; url: string;
}

export function matchThread(threads: ShellThread[], ref: string): ShellThread {
  const t = threads.find((x) => x.id === ref) ?? threads.find((x) => x.id.startsWith(ref)) ?? threads.find((x) => x.title === ref);
  if (!t) throw new Error(`thread not found: ${ref}`);
  return t;
}
export function matchProject(projects: ShellProject[], ref: string): ShellProject {
  const p = projects.find((x) => x.id === ref) ?? projects.find((x) => x.id.startsWith(ref)) ?? projects.find((x) => x.title === ref) ?? projects.find((x) => x.workspaceRoot === ref);
  if (!p) throw new Error(`project not found: ${ref}. Known: ${projects.map((x) => x.title).join(", ")}`);
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
  if (!RUNTIME_MODES.includes(runtimeMode)) throw new Error(`invalid --runtime-mode. Allowed: ${RUNTIME_MODES.join(", ")}`);
  if (!INTERACTION_MODES.includes(interactionMode)) throw new Error(`invalid --interaction-mode. Allowed: ${INTERACTION_MODES.join(", ")}`);
  return { ...o, runtimeMode, interactionMode, model: o.model ?? d.model, effort: o.effort ?? d.effort, env: o.env ?? d.env };
}

/** Resolve the model selection for a new thread: explicit flags → project default → server default. */
export async function resolveNewModel(ctx: Ctx, project: ShellProject, o: Pick<NewThreadOpts, "model" | "effort" | "contextWindow" | "fast">): Promise<{ modelSelection: ModelSelection; settings: Record<string, unknown> }> {
  const [providers, settings] = await Promise.all([fetchProviders(ctx.server, ctx.client.token), fetchServerSettings(ctx.server, ctx.client.token)]);
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

/** Create a thread; unless `draft`, also start its first turn with `text`. */
export async function createThread(ctx: Ctx, g: GlobalOpts, input: NewThreadOpts): Promise<NewThreadSummary> {
  const o = applyDefaults(input);
  const { runtimeMode, interactionMode } = o;
  const draft = o.draft === true;
  const text = o.text;
  if (!draft && !text) throw new Error("missing prompt");
  if (draft && !o.title && !text) throw new Error("--draft needs -t <title> (or a prompt to derive it from)");
  const snoozedUntil = o.snooze ? parseWhen(o.snooze) : undefined;
  const shell = await withAuthRetry(ctx, g, api.shell);
  const project = matchProject(shell.projects, o.project);
  const { modelSelection, settings } = await resolveNewModel(ctx, project, o);

  const envMode = (o.env ?? (settings.defaultThreadEnvMode as string | undefined) ?? "worktree").toLowerCase();
  if (envMode !== "worktree" && envMode !== "local") throw new Error("--env must be worktree|local");
  const currentBranch = gitCurrentBranch(project.workspaceRoot);
  const useWorktree = envMode === "worktree" && Boolean(currentBranch) && currentBranch !== "HEAD";
  const baseBranch = o.base ?? currentBranch;
  const worktreeBranch = o.branch ?? tempBranchName();
  const startFromOrigin = settings.newWorktreesStartFromOrigin === true;

  const threadId = uuid();
  const createdAt = nowIso();
  const title = (o.title ?? text.split("\n")[0]).trim().slice(0, 80) || "Untitled";
  const createThreadPayload = { projectId: project.id, title, modelSelection, runtimeMode, interactionMode, branch: useWorktree ? worktreeBranch : (currentBranch ?? null), worktreePath: null, createdAt };
  const command = draft
    ? { type: "thread.create", commandId: uuid(), threadId, ...createThreadPayload }
    : {
      type: "thread.turn.start",
      commandId: uuid(),
      threadId,
      message: { messageId: uuid(), role: "user", text, attachments: [] },
      modelSelection,
      runtimeMode,
      interactionMode,
      bootstrap: {
        createThread: createThreadPayload,
        ...(useWorktree && baseBranch ? { prepareWorktree: { projectCwd: project.workspaceRoot, baseBranch, branch: worktreeBranch, ...(startFromOrigin ? { startFromOrigin: true } : {}) }, runSetupScript: o.setupScript !== false } : {}),
      },
      createdAt,
    };
  const res = await withAuthRetry(ctx, g, (c) => dispatch(c, command));
  if (snoozedUntil) {
    // The decider rejects snoozing a thread whose turn is still queued (not yet adopted by a session).
    if (!draft) await waitForTurnAdopted(ctx, threadId, 60_000);
    await dispatch(ctx.client, { type: "thread.snooze", commandId: uuid(), threadId, snoozedUntil });
  }
  return {
    threadId, projectId: project.id, project: project.title, title, modelSelection, runtimeMode, interactionMode,
    env: useWorktree ? "worktree" : (draft ? "local (draft)" : "local"), branch: useWorktree ? worktreeBranch : (currentBranch ?? null),
    baseBranch: useWorktree ? (baseBranch ?? null) : null, draft, snoozedUntil: snoozedUntil ?? null, sequence: res.sequence, url: `${ctx.server.origin}/thread/${threadId}`,
  };
}

export interface SendOpts { text: string; model?: string; effort?: string; runtimeMode?: RuntimeMode; interactionMode?: InteractionMode }

/** Start a follow-up turn on an existing (idle, non-archived) thread. */
export async function startTurn(ctx: Ctx, g: GlobalOpts, t: ShellThread, o: SendOpts): Promise<{ threadId: string; sequence: number }> {
  const status = threadStatus(t);
  if (status === "running") throw new Error(`thread ${short(t.id)} is running; interrupt it or wait first`);
  if (t.archivedAt) throw new Error(`thread ${short(t.id)} is archived`);
  let modelSelection = t.modelSelection as ModelSelection | undefined;
  if (o.model || o.effort) {
    const providers = await fetchProviders(ctx.server, ctx.client.token);
    const resolved = resolveModel(providers, o.model ?? `${modelSelection?.instanceId}/${modelSelection?.model}`);
    const baseEffort = (modelSelection?.options ?? []).find((x) => x.id === "effort")?.value;
    modelSelection = buildModelSelection(resolved, { effort: o.effort ?? (typeof baseEffort === "string" ? baseEffort : undefined) });
  }
  const command = {
    type: "thread.turn.start",
    commandId: uuid(),
    threadId: t.id,
    message: { messageId: uuid(), role: "user", text: o.text, attachments: [] },
    ...(modelSelection ? { modelSelection } : {}),
    runtimeMode: o.runtimeMode ?? (t.runtimeMode as RuntimeMode | undefined) ?? "full-access",
    interactionMode: o.interactionMode ?? (t.interactionMode as InteractionMode | undefined) ?? "default",
    createdAt: nowIso(),
  };
  const res = await withAuthRetry(ctx, g, (c) => dispatch(c, command));
  return { threadId: t.id, sequence: res.sequence };
}

/** Poll until the thread's first turn has been adopted by a provider session (or finished). */
export async function waitForTurnAdopted(ctx: Ctx, threadId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = (await api.shell(ctx.client)).threads.find((x) => x.id === threadId);
    if (t && (t.session?.activeTurnId || (t.latestTurn?.state && t.latestTurn.state !== "requested"))) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("timed out waiting for the turn to be adopted; thread created but not snoozed");
}

export function effortOf(ms?: { options?: Array<{ id: string; value: unknown }> }): string | undefined {
  const v = ms?.options?.find((o) => o.id === "effort")?.value;
  return typeof v === "string" ? v : undefined;
}
