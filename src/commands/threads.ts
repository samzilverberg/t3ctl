import { Option, type Command } from "commander";
import { readFileSync } from "node:fs";
import { connect, withAuthRetry, type Ctx, type GlobalOpts } from "../context.js";
import { api, dispatch, rpc, type ShellProject, type ShellThread, type ThreadProjection } from "../http.js";
import { ago, emit, renderTable, short } from "../output.js";
import { RpcSocket } from "../ws.js";
import { uuid } from "../ids.js";
import { createThread, createThreads, parseBatch, startTurn, matchThread, matchProject, effortOf, RUNTIME_MODES, INTERACTION_MODES, type RuntimeMode, type InteractionMode } from "../ops.js";
import { parseWhen } from "../time.js";
import { threadStatus, waitForIdle } from "../wait.js";
import { MAX_BATCH, MIN_BATCH } from "../guard.js";
import { intArg } from "../args.js";
import { derivePendingApprovals, derivePendingUserInputs } from "../pending.js";
import { CliError } from "../errors.js";

const APPROVAL_DECISIONS = ["accept", "acceptForSession", "acceptAlways", "decline"] as const;

/** Live shell snapshot, plus archived threads from `orchestration.getArchivedShellSnapshot` when asked (the HTTP shell leaves them out). */
async function loadThreads(ctx: Ctx, g: GlobalOpts, includeArchived: boolean): Promise<{ threads: ShellThread[]; projects: ShellProject[] }> {
  const shell = await withAuthRetry(ctx, g, api.shell);
  if (!includeArchived) return shell;
  const archived = await withAuthRetry(ctx, g, (c) => rpc<{ threads: ShellThread[]; projects: ShellProject[] }>(c, "orchestration.getArchivedShellSnapshot", {}));
  const seen = new Set<string>();
  const seenP = new Set(shell.projects.map((p) => p.id));
  return {
    // live rows first, then the shell's (usually empty) archivedThreads, then the archived snapshot; first occurrence wins
    threads: [...shell.threads, ...(shell.archivedThreads ?? []), ...archived.threads].filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true))),
    projects: [...shell.projects, ...archived.projects.filter((p) => !seenP.has(p.id))],
  };
}

const APPROVAL_DECISIONS_ALLOWED = [...APPROVAL_DECISIONS, "cancel"] as const;

/** Last `n` messages of a projection (user + assistant + system), oldest first. */
function recentMessages(p: ThreadProjection, n: number) {
  return [...p.messages].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "")).slice(-n).map((m) => ({ id: m.id, role: m.role, text: m.text, runId: m.runId ?? null, createdAt: m.createdAt, streaming: m.streaming === true }));
}

export { matchThread, matchProject } from "../ops.js";

/** `-` (or the `--stdin` alias) reads the prompt from stdin. */
function readPrompt(arg: string | undefined, o: { stdin?: boolean }): string {
  if (o.stdin || arg === "-") return readFileSync(0, "utf8").trim();
  if (!arg) throw new Error("missing prompt (pass it as an argument, or - to read stdin)");
  return arg;
}
const PROMPT_ARG = "prompt text, or - to read it from stdin";
const STDIN_ALIAS = "same as passing - as the prompt";

function shellPoller(client: import("../http.js").Client, threadId: string) {
  return async () => (await api.shell(client)).threads.find((t) => t.id === threadId);
}

export function registerThreads(program: Command) {
  const threads = program.command("threads").alias("thread").description("Read and manage threads");

  threads
    .command("list", { isDefault: true })
    .description("List threads (active by default)")
    .option("-p, --project <ref>", "filter by project id/prefix/title/path")
    .option("-s, --status <status>", "filter by derived status (running|idle|needs-approval|needs-input|error|archived)")
    .option("-a, --all", "include archived threads", false)
    .option("-n, --limit <n>", "max rows", intArg, 50)
    .option("-i, --ids <ids>", "comma-separated thread ids/prefixes to report on (implies -a; unknown ids reported with status missing)")
    .action(async (o: { project?: string; status?: string; all: boolean; limit: number; ids?: string }) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g);
      if (o.ids) o.all = true;
      const shell = await loadThreads(ctx, g, o.all);
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
    .option("-n, --messages <n>", "number of recent messages to print", intArg, 10)
    .addOption(new Option("-t <n>", "deprecated alias of -n").argParser(intArg).hideHelp())
    .addOption(new Option("--turns <n>", "deprecated alias of -n").argParser(intArg).hideHelp())
    .action(async (ref: string, o: { messages: number; t?: number; turns?: number }) => {
      if (o.t !== undefined) o.messages = o.t;
      if (o.turns !== undefined) o.messages = o.turns;
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g);
      const shell = await loadThreads(ctx, g, true);
      const t = matchThread(shell.threads, ref);
      const detail = await api.thread(ctx.client, t.id);
      const p = detail.projection;
      const messages = recentMessages(p, o.messages);
      const latestRun = [...p.runs].sort((a, b) => a.ordinal - b.ordinal).at(-1) ?? null;
      const out = { status: threadStatus(t), snapshotSequence: detail.snapshotSequence, thread: { ...p.thread, status: t.status, activeRunId: t.activeRunId, pendingRuntimeRequest: t.pendingRuntimeRequest ?? null }, latestRun, pendingRequests: p.runtimeRequests.filter((r) => r.status === "pending"), messages, messageCount: p.messages.length, runCount: p.runs.length };
      emit(ctx.format, out, () => {
        const head = [`id       ${t.id}`, `title    ${t.title}`, `status   ${threadStatus(t)}`, `project  ${t.projectId}`, `branch   ${t.branch ?? ""}`, `worktree ${t.worktreePath ?? ""}`, `model    ${t.modelSelection?.instanceId ?? ""}/${t.modelSelection?.model ?? ""}${effortOf(t.modelSelection) ? "@" + effortOf(t.modelSelection) : ""}`, `mode     ${String(t.runtimeMode ?? "")}/${String(t.interactionMode ?? "")}`, `runs     ${p.runs.length}  messages ${p.messages.length}`, ""];
        const msgs = messages.map((m) => `[${m.role}${m.streaming ? "…" : ""}] ${m.text.slice(0, 2000)}`);
        return [...head, ...msgs].join("\n");
      });
    });

  threads
    .command("search <query>")
    .description("Full-text search across thread messages")
    .option("-n, --limit <n>", "1..50", intArg, 20)
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
    .option("--timeout <seconds>", "stop after N seconds", intArg)
    .action(async (ref: string, o: { timeout?: number }) => {
      const ctx = await connect(program.opts<GlobalOpts>());
      const shell = await api.shell(ctx.client);
      const t = matchThread(shell.threads, ref);
      const sock = new RpcSocket(ctx.server, ctx.client.token);
      const ac = new AbortController();
      process.on("SIGINT", () => ac.abort());
      if (o.timeout) setTimeout(() => ac.abort(), o.timeout * 1000).unref();
      try {
        for await (const item of sock.subscribe<unknown>("orchestration.subscribeThread", { threadId: t.id, requestCompletionMarker: true }, ac.signal)) process.stdout.write(JSON.stringify(item) + "\n");
      } finally { sock.close(); }
    });

  threads
    .command("wait <ref>")
    .description("Block until the thread's current turn finishes or it needs a human. Exit 0 idle, 2 needs-human, 3 error, 4 timeout, 5 aborted.")
    .option("--timeout <seconds>", "give up after N seconds", intArg, 1800)
    .option("--require-run", "wait for a run to start even if the thread is idle now", false)
    .addOption(new Option("--require-turn", "deprecated alias of --require-run").hideHelp())
    .action(async (ref: string, o: { timeout: number; requireRun: boolean; requireTurn?: boolean }) => {
      const ctx = await connect(program.opts<GlobalOpts>());
      const shell = await api.shell(ctx.client);
      const t = matchThread(shell.threads, ref);
      const out = await waitForIdle(ctx.server, ctx.client.token, t.id, { timeoutMs: o.timeout * 1000, requireRunStart: o.requireRun || o.requireTurn === true, poll: shellPoller(ctx.client, t.id) });
      emit(ctx.format, out, () => `${out.status} (${out.reason}) after ${out.events} events\n${out.lastAssistantText ? "\n" + out.lastAssistantText.slice(0, 3000) : ""}`);
      process.exitCode = exitCodeFor(out.reason);
    });

  threads
    .command("new")
    .argument("[prompt]", PROMPT_ARG)
    .description(`Create a thread in a project and send the first message. Prints the new thread id. Refuses (exit 6) when a very similar thread was just created in the project or too many were created recently; --batch creates ${MIN_BATCH}-${MAX_BATCH} related threads at once.`)
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
    .option("--stdin", STDIN_ALIAS, false)
    .option("--wait", "wait for the first turn to finish and print the result", false)
    .option("--timeout <seconds>", "with --wait", intArg, 1800)
    .option("--draft", "create the thread without sending a message (no agent turn starts)", false)
    .option("--snooze <when>", "hide the thread from the sidebar until <when> (ISO, 30m/2h/3d, HH:MM, \"tomorrow 09:00\"). Visibility only: a started turn keeps running.")
    .option("--batch <file>", `create ${MIN_BATCH}-${MAX_BATCH} threads: JSON array of prompts or {prompt,title?,model?,effort?,branch?} ('-' = stdin). Other flags apply to all. Skips the duplicate check against recent threads, not the rate limit.`)
    .action(async (promptArg: string | undefined, o: { batch?: string; draft: boolean; snooze?: string; project: string; model?: string; effort?: string; contextWindow?: string; fast?: boolean; title?: string; env?: string; base?: string; branch?: string; runtimeMode?: RuntimeMode; interactionMode?: InteractionMode; stdin: boolean; wait: boolean; timeout: number }) => {
      const g = program.opts<GlobalOpts>();
      if (o.draft && o.wait) throw new Error("--draft starts no turn, so there is nothing to --wait for");
      const shared = { project: o.project, model: o.model, effort: o.effort, contextWindow: o.contextWindow, fast: o.fast, env: o.env, base: o.base, runtimeMode: o.runtimeMode, interactionMode: o.interactionMode, draft: o.draft, snooze: o.snooze };
      if (o.batch !== undefined) {
        const clash = [promptArg !== undefined && "a prompt argument", o.stdin && "--stdin", o.title && "-t", o.branch && "--branch", o.wait && "--wait"].filter(Boolean);
        if (clash.length) throw new Error(`--batch cannot be combined with ${clash.join(", ")} (set title/branch per item; wait with \`threads wait <id>\`)`);
        const items = parseBatch(readFileSync(o.batch === "-" ? 0 : o.batch, "utf8"));
        const ctx = await connect(g, { write: true });
        const created = await createThreads(ctx, g, shared, items);
        emit(ctx.format, created, () => renderTable(created.map((c) => ({ id: c.threadId, title: c.title, model: `${c.modelSelection.model}${effortOf(c.modelSelection) ? "@" + effortOf(c.modelSelection) : ""}`, env: c.env, branch: c.branch ?? "" })), ["id", "title", "model", "env", "branch"]));
        return;
      }
      const ctx = await connect(g, { write: true });
      const text = o.draft && promptArg === undefined && !o.stdin ? "" : readPrompt(promptArg, o);
      const summary = await createThread(ctx, g, { ...shared, title: o.title, branch: o.branch, text }, { guard: true });
      const { threadId, modelSelection, snoozedUntil, project, title } = summary;
      if (!o.wait) {
        emit(ctx.format, summary, () => `created ${threadId}${o.draft ? " (draft, no turn started)" : ""}\nproject  ${project}\ntitle    ${title}\nmodel    ${modelSelection.instanceId}/${modelSelection.model}${effortOf(modelSelection) ? "@" + effortOf(modelSelection) : ""}\nenv      ${summary.env}${summary.env === "worktree" ? ` (${summary.branch} from ${summary.baseBranch})` : ""}${snoozedUntil ? `\nsnoozed  until ${snoozedUntil}` : ""}`);
        return;
      }
      const out = await waitForIdle(ctx.server, ctx.client.token, threadId, { timeoutMs: o.timeout * 1000, requireRunStart: true, poll: shellPoller(ctx.client, threadId) });
      emit(ctx.format, { ...summary, wait: out }, () => `created ${threadId}\n${out.status} (${out.reason})\n\n${out.lastAssistantText ?? ""}`);
      process.exitCode = exitCodeFor(out.reason);
    });

  threads
    .command("send <ref>")
    .argument("[prompt]", PROMPT_ARG)
    .description("Send a follow-up message to an existing thread (starts a run). Refused while a run is active unless --queue or --steer.")
    .option("-m, --model <ref>", "override model for this run (sticks to the thread)")
    .option("-e, --effort <level>", "override effort for this run")
    .option("--runtime-mode <mode>", `${RUNTIME_MODES.join("|")} (changes the thread setting)`)
    .option("--interaction-mode <mode>", `${INTERACTION_MODES.join("|")} (changes the thread setting)`)
    .option("--queue", "if a run is active, queue the message to run after it", false)
    .option("--steer", "if a run is active, inject the message into it", false)
    .option("--stdin", STDIN_ALIAS, false)
    .option("--wait", "wait for the run to finish", false)
    .option("--timeout <seconds>", "with --wait", intArg, 1800)
    .action(async (ref: string, promptArg: string | undefined, o: { model?: string; effort?: string; runtimeMode?: RuntimeMode; interactionMode?: InteractionMode; queue: boolean; steer: boolean; stdin: boolean; wait: boolean; timeout: number }) => {
      const g = program.opts<GlobalOpts>();
      if (o.queue && o.steer) throw new CliError("invalid_option", "pass --queue or --steer, not both", { option: "queue" });
      const ctx = await connect(g, { write: true });
      const text = readPrompt(promptArg, o);
      const shell = await withAuthRetry(ctx, g, api.shell);
      const t = matchThread(shell.threads, ref);
      const res = await startTurn(ctx, g, t, { ...o, text, whenRunning: o.queue ? "queue" : o.steer ? "steer" : "refuse" });
      if (!o.wait) { emit(ctx.format, { threadId: t.id, sequence: res.sequence, dispatchMode: res.dispatchMode }, () => `sent to ${t.id} (seq ${res.sequence}, ${res.dispatchMode})`); return; }
      const out = await waitForIdle(ctx.server, ctx.client.token, t.id, { timeoutMs: o.timeout * 1000, requireRunStart: true, poll: shellPoller(ctx.client, t.id) });
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
      const detail = await api.thread(ctx.client, t.id);
      const out = { threadId: t.id, status: threadStatus(t), approvals: derivePendingApprovals(detail.projection), userInputs: derivePendingUserInputs(detail.projection) };
      emit(ctx.format, out, () => {
        const lines = [`status ${out.status}`];
        for (const a of out.approvals) lines.push(`approval ${a.requestId}  ${a.requestKind ?? ""}  ${(a.detail ?? "").split("\n")[0].slice(0, 120)}  options: ${(a.options ?? []).map((o) => o.decision).join("|") || APPROVAL_DECISIONS.join("|")}`);
        for (const u of out.userInputs) for (const q of u.questions) lines.push(`user-input ${u.requestId}  [${q.id}] ${q.question}  options: ${q.options.map((o) => o.label).join(" | ")}${q.multiSelect ? " (multi)" : ""}`);
        if (lines.length === 1) lines.push("(nothing pending)");
        return lines.join("\n");
      });
    });

  threads
    .command("approve <ref>")
    .description("Respond to a pending approval request (default: the oldest one)")
    .option("-d, --decision <d>", APPROVAL_DECISIONS_ALLOWED.join("|"), "accept")
    .option("-r, --request <id>", "specific requestId (see `threads pending`)")
    .action(async (ref: string, o: { decision: string; request?: string }) => {
      const g = program.opts<GlobalOpts>();
      if (!(APPROVAL_DECISIONS_ALLOWED as readonly string[]).includes(o.decision)) throw new CliError("invalid_option", `invalid decision. Allowed: ${APPROVAL_DECISIONS_ALLOWED.join(", ")}`, { option: "decision", allowed: APPROVAL_DECISIONS_ALLOWED });
      const ctx = await connect(g, { write: true });
      const shell = await withAuthRetry(ctx, g, api.shell);
      const t = matchThread(shell.threads, ref);
      const detail = await api.thread(ctx.client, t.id);
      const pending = derivePendingApprovals(detail.projection);
      const target = o.request ? pending.find((p) => p.requestId === o.request) : pending[0];
      if (!target) throw new CliError("nothing_pending", o.request ? `no pending approval ${o.request}` : `thread ${short(t.id)} has no pending approvals`, { threadId: t.id, requestId: o.request });
      const res = await dispatch(ctx.client, { type: "runtime-request.respond", commandId: uuid(), threadId: t.id, requestId: target.requestId, decision: o.decision });
      emit(ctx.format, { threadId: t.id, requestId: target.requestId, decision: o.decision, sequence: res.sequence }, () => `${o.decision} → ${target.requestId} (${target.requestKind ?? ""} ${(target.detail ?? "").split("\n")[0].slice(0, 80)})`);
    });

  threads
    .command("respond <ref>")
    .description("Answer a pending user-input request. Use --answer <questionId>=<option label> per question, or --json '{...}'.")
    .option("-r, --request <id>", "specific requestId (default: oldest pending)")
    .option("--answer <kv...>", "questionId=answer (repeatable; comma-separate for multi-select)")
    .addOption(new Option("-a <kv...>", "deprecated alias of --answer").hideHelp())
    .option("--json <answers>", "raw answers object keyed by question id")
    .action(async (ref: string, o: { request?: string; answer?: string[]; a?: string[]; json?: string }) => {
      o.answer = [...(o.answer ?? []), ...(o.a ?? [])];
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g, { write: true });
      const shell = await withAuthRetry(ctx, g, api.shell);
      const t = matchThread(shell.threads, ref);
      const detail = await api.thread(ctx.client, t.id);
      const pending = derivePendingUserInputs(detail.projection);
      const target = o.request ? pending.find((p) => p.requestId === o.request) : pending[0];
      if (!target) throw new CliError("nothing_pending", o.request ? `no pending user-input ${o.request}` : `thread ${short(t.id)} has no pending user-input requests`, { threadId: t.id, requestId: o.request });
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
      const res = await dispatch(ctx.client, { type: "runtime-request.respond", commandId: uuid(), threadId: t.id, requestId: target.requestId, answers });
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
    .description("Interrupt the active run (thread.stop); queued messages stay queued")
    .action(async (ref: string) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g, { write: true });
      const shell = await withAuthRetry(ctx, g, api.shell);
      const t = matchThread(shell.threads, ref);
      if (!t.activeRunId) throw new CliError("thread_idle", `thread ${short(t.id)} has no active run`, { threadId: t.id, status: threadStatus(t) });
      const res = await dispatch(ctx.client, { type: "thread.stop", commandId: uuid(), threadId: t.id, reason: "t3ctl interrupt" });
      emit(ctx.format, { threadId: t.id, runId: t.activeRunId, sequence: res.sequence }, () => `interrupt requested for ${t.id} (run ${t.activeRunId})`);
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
        const shell = await loadThreads(ctx, g, name === "unarchive");
        const t = matchThread(shell.threads, ref);
        const res = await dispatch(ctx.client, { type, commandId: uuid(), threadId: t.id });
        emit(ctx.format, { threadId: t.id, sequence: res.sequence }, () => `${name}d ${t.id}`);
      });
  }
}

function exitCodeFor(reason: string): number {
  return reason === "idle" ? 0 : reason === "needs-human" ? 2 : reason === "timeout" ? 4 : reason === "aborted" ? 5 : 3;
}
