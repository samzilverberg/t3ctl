import type { Command } from "commander";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect, withAuthRetry, type GlobalOpts } from "../context.js";
import { api, dispatch, HttpError, type ShellProject, type ShellThread } from "../http.js";
import { ago, emit, renderTable, short } from "../output.js";
import { RpcSocket } from "../ws.js";
import { buildModelSelection, fetchProviders, fetchServerSettings, resolveModel, type ModelSelection } from "../models.js";
import { nowIso, tempBranchName, uuid } from "../ids.js";
import { readConfig } from "../config.js";
import { parseWhen } from "../time.js";
import { threadStatus, waitForIdle } from "../wait.js";
import { derivePendingApprovals, derivePendingUserInputs, type Activity } from "../pending.js";

const APPROVAL_DECISIONS = ["accept", "acceptForSession", "acceptAlways", "decline"] as const;

async function loadThreads(ctx: { server: import("../discover.js").Server; client: import("../http.js").Client }, includeArchived: boolean): Promise<{ threads: ShellThread[]; projects: ShellProject[] }> {
  const shell = await api.shell(ctx.client);
  if (!includeArchived) return shell;
  const sock = new RpcSocket(ctx.server, ctx.client.token);
  try {
    const archived = await sock.request<{ threads: ShellThread[]; projects: ShellProject[] }>("orchestration.getArchivedShellSnapshot", {});
    const seen = new Set(shell.threads.map((t) => t.id));
    return { threads: [...shell.threads, ...archived.threads.filter((t) => !seen.has(t.id))], projects: shell.projects };
  } finally { sock.close(); }
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

const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
type RuntimeMode = (typeof RUNTIME_MODES)[number];
const INTERACTION_MODES = ["default", "plan"] as const;
type InteractionMode = (typeof INTERACTION_MODES)[number];

function gitCurrentBranch(cwd: string): string | undefined {
  try { return execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; } catch { return undefined; }
}

function readPrompt(arg: string | undefined, o: { stdin?: boolean }): string {
  if (o.stdin || arg === "-") return readFileSync(0, "utf8").trim();
  if (!arg) throw new Error("missing prompt (pass as argument, or --stdin)");
  return arg;
}

function shellPoller(client: import("../http.js").Client, threadId: string) {
  return async () => (await api.shell(client)).threads.find((t) => t.id === threadId);
}

export function registerThreads(program: Command) {
  const threads = program.command("threads").alias("thread").description("Read and manage threads");

  threads
    .command("list", { isDefault: true })
    .description("List threads (active by default)")
    .option("-p, --project <ref>", "filter by project id prefix or title")
    .option("-s, --status <status>", "filter by derived status (running|idle|needs-approval|needs-input|error|archived)")
    .option("-a, --all", "include archived threads", false)
    .option("-n, --limit <n>", "max rows", (v) => Number(v), 50)
    .option("-i, --ids <ids>", "comma-separated thread ids/prefixes to report on (implies -a; unknown ids reported with status missing)")
    .action(async (o: { project?: string; status?: string; all: boolean; limit: number; ids?: string }) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g);
      const shell = await withAuthRetry(ctx, g, api.shell);
      if (o.ids) o.all = true;
      if (o.all) {
        // Archived threads are served by a separate RPC, not the live shell snapshot.
        const sock = new RpcSocket(ctx.server, ctx.client.token);
        try {
          const archived = await sock.request<{ threads: ShellThread[]; projects: ShellProject[] }>("orchestration.getArchivedShellSnapshot", {});
          const seen = new Set(shell.threads.map((t) => t.id));
          shell.threads.push(...archived.threads.filter((t) => !seen.has(t.id)));
          const seenP = new Set(shell.projects.map((p) => p.id));
          shell.projects.push(...archived.projects.filter((p) => !seenP.has(p.id)));
        } finally { sock.close(); }
      }
      const byProject = new Map(shell.projects.map((p) => [p.id, p]));
      let list = shell.threads.map((t) => ({ ...t, status: threadStatus(t), projectTitle: byProject.get(t.projectId)?.title ?? "" }));
      if (o.ids) {
        const wanted = o.ids.split(",").map((x) => x.trim()).filter(Boolean);
        list = wanted.map((ref) => list.find((t) => t.id === ref || t.id.startsWith(ref)) ?? ({ id: ref, projectId: "", title: "", status: "missing", projectTitle: "" } as (typeof list)[number]));
        emit(ctx.format, list, () => renderTable(list.map((t) => ({ id: short(t.id), status: t.status, title: t.title.slice(0, 60), updated: ago(t.updatedAt ?? t.createdAt) })), ["id", "status", "title", "updated"]));
        return;
      }
      if (!o.all) list = list.filter((t) => !t.archivedAt);
      if (o.project) { const p = matchProject(shell.projects, o.project); list = list.filter((t) => t.projectId === p.id); }
      if (o.status) list = list.filter((t) => t.status === o.status);
      list.sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? "0") - Date.parse(a.updatedAt ?? a.createdAt ?? "0"));
      list = list.slice(0, o.limit);
      emit(ctx.format, list, () =>
        renderTable(list.map((t) => ({ id: short(t.id), status: t.status, project: t.projectTitle, title: t.title.slice(0, 60), branch: t.branch ?? "", model: `${t.modelSelection?.model ?? ""}${effortOf(t.modelSelection) ? "@" + effortOf(t.modelSelection) : ""}`, updated: ago(t.updatedAt ?? t.createdAt) })),
          ["id", "status", "project", "title", "branch", "model", "updated"]));
    });

  threads
    .command("show <ref>")
    .description("Show a thread with its recent messages")
    .option("-t, --turns <n>", "number of turns to fetch", (v) => Number(v), 5)
    .action(async (ref: string, o: { turns: number }) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g);
      const shell = await loadThreads(ctx, true);
      const t = matchThread(shell.threads, ref);
      // Archived threads have no live detail endpoint (404); fall back to the archived shell row.
      const detail = await api.thread(ctx.client, t.id, o.turns).catch((e: unknown) => {
        if (e instanceof HttpError && e.status === 404 && t.archivedAt) return { snapshotSequence: -1, thread: { ...t, messages: [] }, page: null, note: "archived thread: messages not available via detail endpoint" };
        throw e;
      });
      emit(ctx.format, { status: threadStatus(t), ...detail }, () => {
        const th = detail.thread as Record<string, unknown> & { messages?: Array<Record<string, unknown>> };
        const head = [`id       ${t.id}`, `title    ${t.title}`, `status   ${threadStatus(t)}`, `project  ${t.projectId}`, `branch   ${t.branch ?? ""}`, `worktree ${t.worktreePath ?? ""}`, `model    ${t.modelSelection?.instanceId ?? ""}/${t.modelSelection?.model ?? ""}${effortOf(t.modelSelection) ? "@" + effortOf(t.modelSelection) : ""}`, `mode     ${String(t.runtimeMode ?? "")}/${String(t.interactionMode ?? "")}`, ""];
        const msgs = (th.messages ?? []).map((m) => `[${String(m.role ?? "?")}] ${String(m.text ?? JSON.stringify(m)).slice(0, 2000)}`);
        return [...head, ...msgs].join("\n");
      });
    });

  threads
    .command("search <query>")
    .description("Full-text search across thread messages")
    .option("-n, --limit <n>", "1..50", (v) => Number(v), 20)
    .action(async (query: string, o: { limit: number }) => {
      const ctx = await connect(program.opts<GlobalOpts>());
      const sock = new RpcSocket(ctx.server, ctx.client.token);
      try {
        const res = await sock.request<{ matches: Array<Record<string, unknown>> }>("orchestration.searchThreads", { query, limit: o.limit });
        emit(ctx.format, res.matches, () => renderTable(res.matches.map((m) => ({ thread: short(String(m.threadId)), source: m.source, snippet: String(m.snippet ?? "").replace(/\s+/g, " ").slice(0, 100) })), ["thread", "source", "snippet"]));
      } finally { sock.close(); }
    });

  threads
    .command("watch <ref>")
    .description("Stream live thread events as NDJSON. Ctrl-C to stop.")
    .option("--timeout <seconds>", "stop after N seconds", (v) => Number(v))
    .action(async (ref: string, o: { timeout?: number }) => {
      const ctx = await connect(program.opts<GlobalOpts>());
      const shell = await api.shell(ctx.client);
      const t = matchThread(shell.threads, ref);
      const sock = new RpcSocket(ctx.server, ctx.client.token);
      const ac = new AbortController();
      process.on("SIGINT", () => ac.abort());
      if (o.timeout) setTimeout(() => ac.abort(), o.timeout * 1000).unref();
      try {
        for await (const item of sock.subscribe<unknown>("orchestration.subscribeThread", { threadId: t.id, turnLimit: 1, requestCompletionMarker: true }, ac.signal)) process.stdout.write(JSON.stringify(item) + "\n");
      } finally { sock.close(); }
    });

  threads
    .command("wait <ref>")
    .description("Block until the thread's current turn finishes or it needs a human. Exit 0 idle, 2 needs-human, 3 error, 4 timeout.")
    .option("--timeout <seconds>", "give up after N seconds", (v) => Number(v), 1800)
    .option("--require-turn", "wait for a turn to start even if the thread is idle now", false)
    .action(async (ref: string, o: { timeout: number; requireTurn: boolean }) => {
      const ctx = await connect(program.opts<GlobalOpts>());
      const shell = await api.shell(ctx.client);
      const t = matchThread(shell.threads, ref);
      const out = await waitForIdle(ctx.server, ctx.client.token, t.id, { timeoutMs: o.timeout * 1000, requireTurnStart: o.requireTurn, poll: shellPoller(ctx.client, t.id) });
      emit(ctx.format, out, () => `${out.status} (${out.reason}) after ${out.events} events\n${out.lastAssistantText ? "\n" + out.lastAssistantText.slice(0, 3000) : ""}`);
      process.exitCode = exitCodeFor(out.reason);
    });

  threads
    .command("new [prompt]")
    .description("Create a thread in a project and send the first message. Prints the new thread id.")
    .requiredOption("-p, --project <ref>", "project id/prefix/title/workspaceRoot")
    .option("-m, --model <ref>", "model slug or alias, optionally instanceId/slug (default: project default → server default)")
    .option("-e, --effort <level>", "reasoning effort (low|medium|high|xhigh|max|…, validated per model)")
    .option("--context-window <size>", "e.g. 200k|1m (validated per model)")
    .option("--fast", "enable fastMode where supported")
    .option("-t, --title <title>", "thread title (default: first line of prompt, ≤80 chars)")
    .option("--env <mode>", "worktree|local (default: server setting defaultThreadEnvMode)")
    .option("--base <branch>", "base branch for the worktree (default: current branch of workspaceRoot)")
    .option("--branch <name>", "worktree branch name (default: t3code/<hex>)")
    .option("--runtime-mode <mode>", `${RUNTIME_MODES.join("|")} (default: config defaults.runtimeMode, else auto)`)
    .option("--interaction-mode <mode>", `${INTERACTION_MODES.join("|")} (default: config defaults.interactionMode, else default)`)
    .option("--no-setup-script", "skip the project setup script in the new worktree")
    .option("--stdin", "read prompt from stdin", false)
    .option("--wait", "wait for the first turn to finish and print the result", false)
    .option("--timeout <seconds>", "with --wait", (v) => Number(v), 1800)
    .option("--draft", "create the thread without sending a message (no agent turn starts)", false)
    .option("--snooze <when>", "hide the thread from the sidebar until <when> (ISO, 30m/2h/3d, HH:MM, \"tomorrow 09:00\"). Visibility only: a started turn keeps running.")
    .action(async (promptArg: string | undefined, o: { draft: boolean; snooze?: string; project: string; model?: string; effort?: string; contextWindow?: string; fast?: boolean; title?: string; env?: string; base?: string; branch?: string; runtimeMode?: RuntimeMode; interactionMode?: InteractionMode; setupScript: boolean; stdin: boolean; wait: boolean; timeout: number }) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g, { write: true });
      const d = readConfig().defaults ?? {};
      o.runtimeMode = o.runtimeMode ?? (d.runtimeMode as RuntimeMode | undefined) ?? "auto";
      o.interactionMode = o.interactionMode ?? (d.interactionMode as InteractionMode | undefined) ?? "default";
      // Model resolution order: -m flag → config defaults.model → project default → server default.
      o.model = o.model ?? d.model; o.effort = o.effort ?? d.effort; o.env = o.env ?? d.env;
      const runtimeMode = o.runtimeMode; const interactionMode = o.interactionMode;
      if (!RUNTIME_MODES.includes(runtimeMode)) throw new Error(`invalid --runtime-mode. Allowed: ${RUNTIME_MODES.join(", ")}`);
      if (!INTERACTION_MODES.includes(interactionMode)) throw new Error(`invalid --interaction-mode. Allowed: ${INTERACTION_MODES.join(", ")}`);
      const snoozedUntil = o.snooze ? parseWhen(o.snooze) : undefined;
      const text = o.draft ? (promptArg ?? "") : readPrompt(promptArg, o);
      if (o.draft && !o.title && !text) throw new Error("--draft needs -t <title> (or a prompt to derive it from)");
      const shell = await withAuthRetry(ctx, g, api.shell);
      const project = matchProject(shell.projects, o.project);

      // Model: explicit → project default → server text-generation default.
      const [providers, settings] = await Promise.all([fetchProviders(ctx.server, ctx.client.token), fetchServerSettings(ctx.server, ctx.client.token)]);
      const fallback = (project.defaultModelSelection as ModelSelection | undefined) ?? (settings.textGenerationModelSelection as ModelSelection | undefined);
      let modelSelection: ModelSelection;
      if (o.model || o.effort || o.contextWindow || o.fast !== undefined) {
        const ref = o.model ?? (fallback ? `${fallback.instanceId}/${fallback.model}` : undefined);
        if (!ref) throw new Error("no model given and no default model found; pass --model");
        const resolved = resolveModel(providers, ref);
        // Start from fallback options when user only overrides some knobs on the same model.
        const base = fallback && fallback.model === resolved.model.slug ? Object.fromEntries((fallback.options ?? []).map((x) => [x.id, x.value])) : {};
        modelSelection = buildModelSelection(resolved, {
          effort: o.effort ?? (typeof base.effort === "string" ? base.effort : undefined),
          contextWindow: o.contextWindow ?? (typeof base.contextWindow === "string" ? base.contextWindow : undefined),
          fast: o.fast ?? (typeof base.fastMode === "boolean" ? base.fastMode : undefined),
        });
      } else if (fallback) {
        modelSelection = fallback;
      } else throw new Error("no default model configured; pass --model");

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
      const command = o.draft
        ? { type: "thread.create", commandId: uuid(), threadId, projectId: project.id, title, modelSelection, runtimeMode, interactionMode, branch: useWorktree ? worktreeBranch : (currentBranch ?? null), worktreePath: null, createdAt }
        : {
        type: "thread.turn.start",
        commandId: uuid(),
        threadId,
        message: { messageId: uuid(), role: "user", text, attachments: [] },
        modelSelection,
        runtimeMode,
        interactionMode,
        bootstrap: {
          createThread: { projectId: project.id, title, modelSelection, runtimeMode, interactionMode, branch: useWorktree ? worktreeBranch : (currentBranch ?? null), worktreePath: null, createdAt },
          ...(useWorktree && baseBranch ? { prepareWorktree: { projectCwd: project.workspaceRoot, baseBranch, branch: worktreeBranch, ...(startFromOrigin ? { startFromOrigin: true } : {}) }, runSetupScript: o.setupScript } : {}),
        },
        createdAt,
      };
      const res = await withAuthRetry(ctx, g, (c) => dispatch(c, command));
      if (snoozedUntil) {
        // The decider rejects snoozing a thread whose turn is still queued (not yet adopted by a session).
        if (!o.draft) await waitForTurnAdopted(ctx.client, threadId, 60_000);
        await dispatch(ctx.client, { type: "thread.snooze", commandId: uuid(), threadId, snoozedUntil });
      }
      const summary = { threadId, projectId: project.id, project: project.title, title, modelSelection, runtimeMode, interactionMode, env: useWorktree ? "worktree" : (o.draft ? "local (draft)" : "local"), branch: useWorktree ? worktreeBranch : currentBranch ?? null, baseBranch: useWorktree ? baseBranch : null, draft: o.draft, snoozedUntil: snoozedUntil ?? null, sequence: res.sequence, url: `${ctx.server.origin}/thread/${threadId}` };
      if (!o.wait || o.draft) {
        emit(ctx.format, summary, () => `created ${threadId}${o.draft ? " (draft, no turn started)" : ""}\nproject  ${project.title}\ntitle    ${title}\nmodel    ${modelSelection.instanceId}/${modelSelection.model}${effortOf(modelSelection) ? "@" + effortOf(modelSelection) : ""}\nenv      ${summary.env}${useWorktree ? ` (${worktreeBranch} from ${baseBranch})` : ""}${snoozedUntil ? `\nsnoozed  until ${snoozedUntil}` : ""}`);
        return;
      }
      const out = await waitForIdle(ctx.server, ctx.client.token, threadId, { timeoutMs: o.timeout * 1000, requireTurnStart: true, poll: shellPoller(ctx.client, threadId) });
      emit(ctx.format, { ...summary, wait: out }, () => `created ${threadId}\n${out.status} (${out.reason})\n\n${out.lastAssistantText ?? ""}`);
      process.exitCode = exitCodeFor(out.reason);
    });

  threads
    .command("send <ref> [prompt]")
    .description("Send a follow-up message to an existing thread (starts a turn)")
    .option("-m, --model <ref>", "override model for this turn")
    .option("-e, --effort <level>", "override effort for this turn")
    .option("--runtime-mode <mode>", RUNTIME_MODES.join("|"))
    .option("--interaction-mode <mode>", INTERACTION_MODES.join("|"))
    .option("--stdin", "read prompt from stdin", false)
    .option("--wait", "wait for the turn to finish", false)
    .option("--timeout <seconds>", "with --wait", (v) => Number(v), 1800)
    .action(async (ref: string, promptArg: string | undefined, o: { model?: string; effort?: string; runtimeMode?: RuntimeMode; interactionMode?: InteractionMode; stdin: boolean; wait: boolean; timeout: number }) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g, { write: true });
      const text = readPrompt(promptArg, o);
      const shell = await withAuthRetry(ctx, g, api.shell);
      const t = matchThread(shell.threads, ref);
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
        message: { messageId: uuid(), role: "user", text, attachments: [] },
        ...(modelSelection ? { modelSelection } : {}),
        runtimeMode: o.runtimeMode ?? (t.runtimeMode as RuntimeMode | undefined) ?? "full-access",
        interactionMode: o.interactionMode ?? (t.interactionMode as InteractionMode | undefined) ?? "default",
        createdAt: nowIso(),
      };
      const res = await withAuthRetry(ctx, g, (c) => dispatch(c, command));
      if (!o.wait) { emit(ctx.format, { threadId: t.id, sequence: res.sequence }, () => `sent to ${t.id} (seq ${res.sequence})`); return; }
      const out = await waitForIdle(ctx.server, ctx.client.token, t.id, { timeoutMs: o.timeout * 1000, requireTurnStart: true, poll: shellPoller(ctx.client, t.id) });
      emit(ctx.format, { threadId: t.id, sequence: res.sequence, wait: out }, () => `${out.status} (${out.reason})\n\n${out.lastAssistantText ?? ""}`);
      process.exitCode = exitCodeFor(out.reason);
    });

  threads
    .command("pending <ref>")
    .description("Show open approval / user-input requests the thread is blocked on")
    .action(async (ref: string) => {
      const ctx = await connect(program.opts<GlobalOpts>());
      const shell = await api.shell(ctx.client);
      const t = matchThread(shell.threads, ref);
      const detail = await api.thread(ctx.client, t.id, 3);
      const acts = ((detail.thread as { activities?: Activity[] }).activities ?? []);
      const out = { threadId: t.id, status: threadStatus(t), approvals: derivePendingApprovals(acts), userInputs: derivePendingUserInputs(acts) };
      emit(ctx.format, out, () => {
        const lines = [`status ${out.status}`];
        for (const a of out.approvals) lines.push(`approval ${a.requestId}  ${a.requestKind ?? a.requestType ?? ""}  ${a.detail ?? ""}  options: ${(a.options ?? []).map((o) => o.decision).join("|") || APPROVAL_DECISIONS.join("|")}`);
        for (const u of out.userInputs) for (const q of u.questions) lines.push(`user-input ${u.requestId}  [${q.id}] ${q.question}  options: ${q.options.map((o) => o.label).join(" | ")}${q.multiSelect ? " (multi)" : ""}`);
        if (lines.length === 1) lines.push("(nothing pending)");
        return lines.join("\n");
      });
    });

  threads
    .command("approve <ref>")
    .description("Respond to a pending approval request (default: the oldest one)")
    .option("-d, --decision <d>", APPROVAL_DECISIONS.join("|"), "accept")
    .option("-r, --request <id>", "specific requestId (see `threads pending`)")
    .action(async (ref: string, o: { decision: string; request?: string }) => {
      const g = program.opts<GlobalOpts>();
      if (!(APPROVAL_DECISIONS as readonly string[]).includes(o.decision)) throw new Error(`invalid decision. Allowed: ${APPROVAL_DECISIONS.join(", ")}`);
      const ctx = await connect(g, { write: true });
      const shell = await withAuthRetry(ctx, g, api.shell);
      const t = matchThread(shell.threads, ref);
      const detail = await api.thread(ctx.client, t.id, 3);
      const pending = derivePendingApprovals(((detail.thread as { activities?: Activity[] }).activities ?? []));
      const target = o.request ? pending.find((p) => p.requestId === o.request) : pending[0];
      if (!target) throw new Error(o.request ? `no pending approval ${o.request}` : `thread ${short(t.id)} has no pending approvals`);
      const res = await dispatch(ctx.client, { type: "thread.approval.respond", commandId: uuid(), threadId: t.id, requestId: target.requestId, decision: o.decision, createdAt: nowIso() });
      emit(ctx.format, { threadId: t.id, requestId: target.requestId, decision: o.decision, sequence: res.sequence }, () => `${o.decision} → ${target.requestId} (${target.requestKind ?? ""} ${target.detail ?? ""})`);
    });

  threads
    .command("respond <ref>")
    .description("Answer a pending user-input request. Use -a <questionId>=<option label> per question, or --json '{...}'.")
    .option("-r, --request <id>", "specific requestId (default: oldest pending)")
    .option("-a, --answer <kv...>", "questionId=answer (repeatable; comma-separate for multi-select)")
    .option("--json <answers>", "raw answers object keyed by question id")
    .action(async (ref: string, o: { request?: string; answer?: string[]; json?: string }) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g, { write: true });
      const shell = await withAuthRetry(ctx, g, api.shell);
      const t = matchThread(shell.threads, ref);
      const detail = await api.thread(ctx.client, t.id, 3);
      const pending = derivePendingUserInputs(((detail.thread as { activities?: Activity[] }).activities ?? []));
      const target = o.request ? pending.find((p) => p.requestId === o.request) : pending[0];
      if (!target) throw new Error(o.request ? `no pending user-input ${o.request}` : `thread ${short(t.id)} has no pending user-input requests`);
      let answers: Record<string, unknown> = {};
      if (o.json) answers = JSON.parse(o.json) as Record<string, unknown>;
      for (const kv of o.answer ?? []) {
        const i = kv.indexOf("="); if (i < 0) throw new Error(`bad --answer "${kv}", expected questionId=answer`);
        const qid = kv.slice(0, i); const val = kv.slice(i + 1);
        const q = target.questions.find((x) => x.id === qid);
        if (!q) throw new Error(`unknown question "${qid}". Questions: ${target.questions.map((x) => x.id).join(", ")}`);
        answers[qid] = q.multiSelect ? val.split(",").map((x) => x.trim()) : val;
      }
      const missing = target.questions.filter((q) => !(q.id in answers));
      if (missing.length) throw new Error(`unanswered questions: ${missing.map((q) => `${q.id} (${q.options.map((x) => x.label).join(" | ")})`).join("; ")}`);
      const res = await dispatch(ctx.client, { type: "thread.user-input.respond", commandId: uuid(), threadId: t.id, requestId: target.requestId, answers, createdAt: nowIso() });
      emit(ctx.format, { threadId: t.id, requestId: target.requestId, answers, sequence: res.sequence }, () => `answered ${target.requestId}`);
    });

  threads
    .command("snooze <ref>")
    .description("Hide a thread from the sidebar until <when>. Visibility only: a running agent keeps running. Rejected while the thread has a pending approval/user-input.")
    .requiredOption("-u, --until <when>", "ISO, 30m/2h/3d/1w, HH:MM, or \"tomorrow [HH:MM]\"")
    .action(async (ref: string, o: { until: string }) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g, { write: true });
      const snoozedUntil = parseWhen(o.until);
      const shell = await withAuthRetry(ctx, g, api.shell);
      const t = matchThread(shell.threads, ref);
      const res = await dispatch(ctx.client, { type: "thread.snooze", commandId: uuid(), threadId: t.id, snoozedUntil });
      emit(ctx.format, { threadId: t.id, snoozedUntil, sequence: res.sequence }, () => `snoozed ${t.id} until ${snoozedUntil}`);
    });

  threads
    .command("unsnooze <ref>")
    .description("Bring a snoozed thread back now")
    .action(async (ref: string) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g, { write: true });
      const shell = await withAuthRetry(ctx, g, api.shell);
      const t = matchThread(shell.threads, ref);
      const res = await dispatch(ctx.client, { type: "thread.unsnooze", commandId: uuid(), threadId: t.id, reason: "user" });
      emit(ctx.format, { threadId: t.id, sequence: res.sequence }, () => `unsnoozed ${t.id}`);
    });

  threads
    .command("interrupt <ref>")
    .description("Interrupt the running turn")
    .action(async (ref: string) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g, { write: true });
      const shell = await withAuthRetry(ctx, g, api.shell);
      const t = matchThread(shell.threads, ref);
      const res = await dispatch(ctx.client, { type: "thread.turn.interrupt", commandId: uuid(), threadId: t.id, ...(t.session?.activeTurnId ? { turnId: t.session.activeTurnId } : {}), createdAt: nowIso() });
      emit(ctx.format, { threadId: t.id, sequence: res.sequence }, () => `interrupt requested for ${t.id}`);
    });

  threads
    .command("settle <ref>")
    .description("Mark a thread settled (T3's 'done for now' state; hides from the active inbox)")
    .action(async (ref: string) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g, { write: true });
      const shell = await withAuthRetry(ctx, g, api.shell);
      const t = matchThread(shell.threads, ref);
      const res = await dispatch(ctx.client, { type: "thread.settle", commandId: uuid(), threadId: t.id });
      emit(ctx.format, { threadId: t.id, sequence: res.sequence }, () => `settled ${t.id}`);
    });

  threads
    .command("unsettle <ref>")
    .description("Return a settled thread to the active inbox")
    .action(async (ref: string) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g, { write: true });
      const shell = await withAuthRetry(ctx, g, api.shell);
      const t = matchThread(shell.threads, ref);
      const res = await dispatch(ctx.client, { type: "thread.unsettle", commandId: uuid(), threadId: t.id, reason: "user" });
      emit(ctx.format, { threadId: t.id, sequence: res.sequence }, () => `unsettled ${t.id}`);
    });

  for (const [name, type] of [["archive", "thread.archive"], ["unarchive", "thread.unarchive"]] as const) {
    threads
      .command(`${name} <ref>`)
      .description(`${name[0].toUpperCase() + name.slice(1)} a thread`)
      .action(async (ref: string) => {
        const g = program.opts<GlobalOpts>();
        const ctx = await connect(g, { write: true });
        const shell = await loadThreads(ctx, name === "unarchive");
        const t = matchThread(shell.threads, ref);
        const res = await dispatch(ctx.client, { type, commandId: uuid(), threadId: t.id });
        emit(ctx.format, { threadId: t.id, sequence: res.sequence }, () => `${name}d ${t.id}`);
      });
  }
}

/** Poll until the thread's first turn has been adopted by a provider session (or finished). */
async function waitForTurnAdopted(client: import("../http.js").Client, threadId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = (await api.shell(client)).threads.find((x) => x.id === threadId);
    if (t && (t.session?.activeTurnId || (t.latestTurn?.state && t.latestTurn.state !== "requested"))) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("timed out waiting for the turn to be adopted; thread created but not snoozed");
}

function effortOf(ms?: { options?: Array<{ id: string; value: unknown }> }): string | undefined {
  const v = ms?.options?.find((o) => o.id === "effort")?.value;
  return typeof v === "string" ? v : undefined;
}
function exitCodeFor(reason: string): number {
  return reason === "idle" ? 0 : reason === "needs-human" ? 2 : reason === "timeout" ? 4 : reason === "aborted" ? 5 : 3;
}
