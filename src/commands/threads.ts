import type { Command } from "commander";
import { connect, type GlobalOpts } from "../context.js";
import { api, type ShellThread } from "../http.js";
import { ago, emit, renderTable, short } from "../output.js";
import { RpcSocket } from "../ws.js";

/** Mirrors the UI's idle heuristic: no active turn and latest turn in a terminal state. */
export function threadStatus(t: ShellThread): string {
  if (t.archivedAt) return "archived";
  if (t.hasPendingApprovals) return "needs-approval";
  if (t.hasPendingUserInput) return "needs-input";
  const active = t.session?.activeTurnId;
  if (active) return "running";
  const st = t.latestTurn?.state;
  if (st === "completed") return "idle";
  if (st === "error") return "error";
  if (st === "interrupted") return "interrupted";
  if (t.session?.status) return t.session.status;
  return st ?? "new";
}

function matchThread(threads: ShellThread[], ref: string): ShellThread {
  const t = threads.find((x) => x.id === ref) ?? threads.find((x) => x.id.startsWith(ref)) ?? threads.find((x) => x.title === ref);
  if (!t) throw new Error(`thread not found: ${ref}`);
  return t;
}

export function registerThreads(program: Command) {
  const threads = program.command("threads").alias("thread").description("Read threads");

  threads
    .command("list", { isDefault: true })
    .description("List threads (active by default)")
    .option("-p, --project <idOrTitle>", "filter by project id prefix or title")
    .option("-s, --status <status>", "filter by derived status (running|idle|needs-approval|needs-input|error|archived)")
    .option("-a, --all", "include archived threads", false)
    .option("-n, --limit <n>", "max rows", (v) => Number(v), 50)
    .action(async (o: { project?: string; status?: string; all: boolean; limit: number }) => {
      const { client, format } = await connect(program.opts<GlobalOpts>());
      const shell = await api.shell(client);
      const byProject = new Map(shell.projects.map((p) => [p.id, p]));
      let list = shell.threads.map((t) => ({ ...t, status: threadStatus(t), projectTitle: byProject.get(t.projectId)?.title ?? "" }));
      if (!o.all) list = list.filter((t) => !t.archivedAt);
      if (o.project) list = list.filter((t) => t.projectId.startsWith(o.project!) || t.projectTitle === o.project);
      if (o.status) list = list.filter((t) => t.status === o.status);
      list.sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? "0") - Date.parse(a.updatedAt ?? a.createdAt ?? "0"));
      list = list.slice(0, o.limit);
      emit(format, list, () =>
        renderTable(
          list.map((t) => ({ id: short(t.id), status: t.status, project: t.projectTitle, title: t.title.slice(0, 60), branch: t.branch ?? "", model: t.modelSelection?.model ?? "", updated: ago(t.updatedAt ?? t.createdAt) })),
          ["id", "status", "project", "title", "branch", "model", "updated"]));
    });

  threads
    .command("show <idOrTitle>")
    .description("Show a thread with its recent messages")
    .option("-t, --turns <n>", "number of turns to fetch", (v) => Number(v), 5)
    .action(async (ref: string, o: { turns: number }) => {
      const { client, format } = await connect(program.opts<GlobalOpts>());
      const shell = await api.shell(client);
      const t = matchThread(shell.threads, ref);
      const detail = await api.thread(client, t.id, o.turns);
      emit(format, detail, () => {
        const th = detail.thread as Record<string, unknown> & { messages?: Array<Record<string, unknown>> };
        const head = [`id       ${t.id}`, `title    ${t.title}`, `status   ${threadStatus(t)}`, `project  ${t.projectId}`, `branch   ${t.branch ?? ""}`, `worktree ${t.worktreePath ?? ""}`, `model    ${t.modelSelection?.instanceId ?? ""}/${t.modelSelection?.model ?? ""}`, ""];
        const msgs = (th.messages ?? []).map((m) => `[${String(m.role ?? "?")}] ${String(m.text ?? JSON.stringify(m)).slice(0, 2000)}`);
        return [...head, ...msgs].join("\n");
      });
    });

  threads
    .command("search <query>")
    .description("Full-text search across thread messages (WS RPC orchestration.searchThreads)")
    .option("-n, --limit <n>", "1..50", (v) => Number(v), 20)
    .action(async (query: string, o: { limit: number }) => {
      const { client, format, server } = await connect(program.opts<GlobalOpts>());
      const sock = new RpcSocket(server, client.token);
      try {
        const res = await sock.request<{ matches: Array<Record<string, unknown>> }>("orchestration.searchThreads", { query, limit: o.limit });
        emit(format, res.matches, () => renderTable(res.matches.map((m) => ({ thread: short(String(m.threadId)), source: m.source, snippet: String(m.snippet ?? "").replace(/\s+/g, " ").slice(0, 100) })), ["thread", "source", "snippet"]));
      } finally { sock.close(); }
    });

  threads
    .command("watch <idOrTitle>")
    .description("Stream live thread events as NDJSON (WS orchestration.subscribeThread). Ctrl-C to stop.")
    .option("--until-idle", "exit once the thread's current turn finishes", false)
    .option("--timeout <seconds>", "give up after N seconds", (v) => Number(v))
    .action(async (ref: string, o: { untilIdle: boolean; timeout?: number }) => {
      const { client, server } = await connect(program.opts<GlobalOpts>());
      const shell = await api.shell(client);
      const t = matchThread(shell.threads, ref);
      const sock = new RpcSocket(server, client.token);
      const ac = new AbortController();
      process.on("SIGINT", () => ac.abort());
      if (o.timeout) setTimeout(() => ac.abort(), o.timeout * 1000).unref();
      let sawActive = threadStatus(t) === "running";
      try {
        for await (const item of sock.subscribe<Record<string, unknown>>("orchestration.subscribeThread", { threadId: t.id, turnLimit: 1, requestCompletionMarker: true }, ac.signal)) {
          process.stdout.write(JSON.stringify(item) + "\n");
          if (!o.untilIdle) continue;
          const ev = item.event as Record<string, unknown> | undefined;
          if (item.kind === "event" && ev) {
            const type = String(ev.type);
            if (type === "thread.turn-start-requested") sawActive = true;
            if (type === "thread.session-set") {
              const s = ev.session as { status?: string; activeTurnId?: string | null } | undefined;
              if (s?.activeTurnId) sawActive = true;
              else if (sawActive && s && !s.activeTurnId) { ac.abort(); }
            }
          }
        }
      } finally { sock.close(); }
    });
}
