/**
 * In-process stand-in for a T3 Code 0.1 server, just enough for the CLI tests: the environment descriptor (with
 * `orchestrationProtocolVersion`), the V2 shell and thread-projection reads (which require the
 * `x-t3-orchestration-protocol: 2` header), `/api/projects/mutate`, and the WS RPCs `server.getConfig`,
 * `orchestration.dispatchCommand`, `orchestration.launchThread` and `scheduledTasks.*`. Not a protocol reference;
 * see docs/research for that.
 */
import { createServer, type Server as HttpServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { WebSocketServer } from "ws";
import type { Message, ShellProject, ShellThread } from "../src/http.js";
import { makeClient, PROTOCOL_HEADER } from "../src/http.js";
import type { Ctx } from "../src/context.js";
import type { ScheduledTask } from "../src/schedule.js";

const providers = JSON.parse(readFileSync(new URL("./fixtures/providers.json", import.meta.url), "utf8")) as unknown[];

export interface Fake {
  origin: string;
  project: ShellProject;
  threads: ShellThread[];
  messages: Map<string, Message[]>;
  commands: Array<Record<string, unknown>>;
  /** `orchestration.launchThread` inputs, in order. */
  launches: Array<Record<string, unknown>>;
  /** `/api/projects/mutate` bodies. */
  mutations: Array<Record<string, unknown>>;
  tasks: ScheduledTask[];
  /** Make the n-th dispatch/launch from now (1-based) fail with an RPC Failure. */
  failDispatch?: number;
  /** Descriptor fields to override (e.g. an old `serverVersion`). */
  descriptor: Record<string, unknown>;
  ctx: Ctx;
  /** Add an existing thread created `secondsAgo` ago with `prompt` as its first user message. */
  seed(title: string, prompt: string | undefined, secondsAgo: number, extra?: Partial<ShellThread>): ShellThread;
  close(): Promise<void>;
}

export async function startFake(): Promise<Fake> {
  const project: ShellProject = {
    id: "11111111-2222-3333-4444-555555555555", title: "dev", workspaceRoot: mkdtempSync(join(tmpdir(), "t3ctl-fake-")),
    defaultModelSelection: { instanceId: "claudeAgent", model: "claude-opus-4-8" }, defaultThreadEnvMode: null,
  };
  const threads: ShellThread[] = [];
  const messages = new Map<string, Message[]>();
  const commands: Array<Record<string, unknown>> = [];
  const launches: Array<Record<string, unknown>> = [];
  const mutations: Array<Record<string, unknown>> = [];
  const tasks: ScheduledTask[] = [];
  let seq = 0;
  let n = 0;
  const descriptor: Record<string, unknown> = { environmentId: "fake-env", label: "fake", platform: { os: "darwin", arch: "arm64" }, serverVersion: "0.1.1", orchestrationProtocolVersion: 2, capabilities: { serverSelfUpdate: "desktop-managed" } };

  const http: HttpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (v: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (url.pathname === "/.well-known/t3/environment") return json(descriptor);
    if (url.pathname === "/api/auth/session") return json({ authenticated: true, scopes: ["orchestration:read", "orchestration:operate"], sessionMethod: "bearer-access-token" });
    if (url.pathname === "/api/projects/mutate") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => { const m = JSON.parse(body) as Record<string, unknown>; mutations.push(m); json({ id: m.projectId, title: m.title ?? project.title, workspaceRoot: m.workspaceRoot ?? project.workspaceRoot }); });
      return;
    }
    if (url.pathname.startsWith("/api/orchestration/")) {
      // Orchestrator V2 refuses reads that do not declare the protocol generation.
      if (req.headers[PROTOCOL_HEADER] !== "2") return json({ error: "protocol header missing" }, 400);
      if (url.pathname === "/api/orchestration/shell") return json({ schemaVersion: 1, snapshotSequence: seq, projects: [project], threads: threads.filter((t) => !t.archivedAt), archivedThreads: threads.filter((t) => t.archivedAt) });
      const m = /^\/api\/orchestration\/threads\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const t = threads.find((x) => x.id === decodeURIComponent(m[1]));
        return t ? json({ snapshotSequence: seq, projection: { thread: t, runs: [], attempts: [], runtimeRequests: [], messages: messages.get(t.id) ?? [], turnItems: [] } }) : json({ error: "not found" }, 404);
      }
    }
    json({ error: "not found" }, 404);
  });

  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/ws") { socket.destroy(); return; }
    if (url.searchParams.get("orchestrationProtocol") !== "2") {
      socket.write('HTTP/1.1 426 Upgrade Required\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{"code":"orchestration_protocol_incompatible","message":"Update this client to one that supports orchestration protocol 2.","orchestrationProtocolVersion":2}');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  const addThread = (id: string, title: string, extra: Partial<ShellThread> = {}) => {
    const t: ShellThread = { id, projectId: project.id, title, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), archivedAt: null, status: "idle", activeRunId: null, pendingRuntimeRequest: null, ...extra };
    threads.push(t);
    return t;
  };
  const addMessage = (threadId: string, text: string, role = "user") => messages.set(threadId, [...(messages.get(threadId) ?? []), { id: `m${++n}`, threadId, role, text, createdAt: new Date().toISOString() }]);
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString()) as { _tag: string; id?: string; tag?: string; payload?: Record<string, unknown> };
      if (f._tag !== "Request") return;
      const ok = (value: unknown) => ws.send(JSON.stringify({ _tag: "Exit", requestId: f.id, exit: { _tag: "Success", value } }));
      const fail = (error: unknown) => ws.send(JSON.stringify({ _tag: "Exit", requestId: f.id, exit: { _tag: "Failure", cause: { _tag: "Fail", error } } }));
      const maybeFail = () => { if (fake.failDispatch !== undefined && --fake.failDispatch === 0) { fake.failDispatch = undefined; fail("boom"); return true; } return false; };
      const p = f.payload ?? {};
      switch (f.tag) {
        case "server.getConfig": return ok({ providers, settings: { defaultThreadEnvMode: "local" } });
        case "orchestration.getArchivedShellSnapshot": return ok({ projects: [], threads: threads.filter((t) => t.archivedAt) });
        case "orchestration.launchThread": {
          if (maybeFail()) return;
          launches.push(p);
          commands.push({ type: "orchestration.launchThread", ...p });   // so command counts cover creates too
          const t = addThread(String(p.threadId), String(p.title), { status: "running", activeRunId: "run:1" });
          const msg = p.initialMessage as { text: string } | undefined;
          if (msg) addMessage(t.id, msg.text);
          return ok({ threadId: t.id, resumed: false, projection: { thread: t, runs: [], attempts: [], runtimeRequests: [], messages: messages.get(t.id) ?? [], turnItems: [] } });
        }
        case "orchestration.dispatchCommand": {
          if (maybeFail()) return;
          commands.push(p);
          if (p.type === "thread.create") addThread(String(p.threadId), String(p.title));
          if (p.type === "message.dispatch") addMessage(String(p.threadId), String(p.text));
          if (p.type === "thread.archive") { const t = threads.find((x) => x.id === p.threadId); if (t) t.archivedAt = new Date().toISOString(); }
          return ok({ sequence: ++seq });
        }
        case "scheduledTasks.list": return ok({ tasks });
        case "scheduledTasks.upsert": {
          const existing = tasks.find((t) => t.id === p.id);
          if (p.requireExisting && !existing) return fail({ _tag: "ScheduledTaskError", message: "not found" });
          const now = new Date().toISOString();
          const task = { ...(existing ?? { id: `task-${++n}`, createdAt: now, lastRunAt: null, lastRunStatus: "never", lastRunError: null, runCount: 0 }), ...p, updatedAt: now, nextRunAt: p.enabled ? "2030-01-01T09:00:00.000Z" : null } as unknown as ScheduledTask;
          delete (task as Record<string, unknown>).commandId; delete (task as Record<string, unknown>).requireExisting;
          if (existing) tasks[tasks.indexOf(existing)] = task; else tasks.push(task);
          return ok({ task });
        }
        case "scheduledTasks.setEnabled": { const t = tasks.find((x) => x.id === p.id); if (!t) return fail("not found"); t.enabled = Boolean(p.enabled); t.nextRunAt = t.enabled ? "2030-01-01T09:00:00.000Z" : null; return ok({ task: t }); }
        case "scheduledTasks.delete": { const i = tasks.findIndex((x) => x.id === p.id); if (i < 0) return fail("not found"); tasks.splice(i, 1); return ok({ id: p.id }); }
        case "scheduledTasks.runNow": { const t = tasks.find((x) => x.id === p.id); if (!t) return fail("not found"); t.runCount++; t.lastRunStatus = "succeeded"; t.lastRunAt = new Date().toISOString(); return ok({ task: t }); }
        default: return fail(`unhandled ${f.tag}`);
      }
    });
  });

  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const addr = http.address();
  const origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const server = { origin, descriptor: { environmentId: "fake-env", label: "fake", platform: { os: "darwin", arch: "arm64" }, serverVersion: "0.1.1", orchestrationProtocolVersion: 2, capabilities: {} }, source: "env" as const, isDesktopBackend: true, degraded: false };

  const fake: Fake = {
    origin, project, threads, messages, commands, launches, mutations, tasks, descriptor,
    ctx: { server, client: makeClient(server, "fake-token"), format: "json" },
    seed(title, prompt, secondsAgo, extra = {}) {
      const t = addThread(`00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`, title, { createdAt: new Date(Date.now() - secondsAgo * 1000).toISOString(), ...extra });
      if (prompt !== undefined) addMessage(t.id, prompt);
      return t;
    },
    close: () => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(); http.close(() => r()); }),
  };
  return fake;
}

/**
 * Run the real CLI (via tsx) against `origin` with `T3CTL_TOKEN` and a fresh config dir (no stored scopes: the env
 * token must be used as-is, never trigger a pairing). `config` seeds config.json.
 */
export function runCli(origin: string, args: string[], stdin?: string, config: Record<string, unknown> = {}, env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const configDir = mkdtempSync(join(tmpdir(), "t3ctl-cfg-"));
  writeFileSync(join(configDir, "config.json"), JSON.stringify(config));
  const entry = new URL("../src/index.ts", import.meta.url).pathname;
  return new Promise((resolve) => {
    const child = execFile(process.execPath, ["--import", "tsx", entry, "--origin", origin, "-f", "json", ...args], {
      env: { ...process.env, T3CTL_TOKEN: "fake-token", T3CTL_CONFIG_DIR: configDir, ...env },
    }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
    if (stdin !== undefined) child.stdin?.end(stdin); else child.stdin?.end();
  });
}
