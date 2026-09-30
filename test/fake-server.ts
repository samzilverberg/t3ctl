/**
 * In-process stand-in for the T3 server, just enough for `threads new`: the environment descriptor, the shell and
 * thread-detail reads, and the WS RPCs `server.getConfig` + `orchestration.dispatchCommand` (which records the
 * command and adds the thread to the shell). Not a protocol reference; see docs/research for that.
 */
import { createServer, type Server as HttpServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { WebSocketServer } from "ws";
import type { ShellProject, ShellThread } from "../src/http.js";
import { makeClient } from "../src/http.js";
import type { Ctx } from "../src/context.js";

const providers = JSON.parse(readFileSync(new URL("./fixtures/providers.json", import.meta.url), "utf8")) as unknown[];

export interface Fake {
  origin: string;
  project: ShellProject;
  threads: ShellThread[];
  messages: Map<string, Array<{ role: string; text: string }>>;
  commands: Array<Record<string, unknown>>;
  /** Make the n-th dispatch from now (1-based) fail with an RPC Failure. */
  failDispatch?: number;
  ctx: Ctx;
  /** Add an existing thread created `secondsAgo` ago with `prompt` as its first user message. */
  seed(title: string, prompt: string | undefined, secondsAgo: number): ShellThread;
  close(): Promise<void>;
}

export async function startFake(): Promise<Fake> {
  const project: ShellProject = {
    id: "11111111-2222-3333-4444-555555555555", title: "dev", workspaceRoot: mkdtempSync(join(tmpdir(), "t3ctl-fake-")),
    defaultModelSelection: { instanceId: "claudeAgent", model: "claude-opus-4-8" },
  };
  const threads: ShellThread[] = [];
  const messages = new Map<string, Array<{ role: string; text: string }>>();
  const commands: Array<Record<string, unknown>> = [];
  let seq = 0;
  let n = 0;

  const http: HttpServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (v: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (url.pathname === "/.well-known/t3/environment") return json({ environmentId: "fake-env", label: "fake", platform: { os: "darwin", arch: "arm64" }, serverVersion: "0.0.0", capabilities: { serverSelfUpdate: "desktop-managed" } });
    if (url.pathname === "/api/orchestration/shell") return json({ snapshotSequence: seq, projects: [project], threads });
    const m = /^\/api\/orchestration\/threads\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const t = threads.find((x) => x.id === decodeURIComponent(m[1]));
      return t ? json({ snapshotSequence: seq, thread: { ...t, messages: messages.get(t.id) ?? [] } }) : json({ error: "not found" }, 404);
    }
    json({ error: "not found" }, 404);
  });

  const wss = new WebSocketServer({ server: http, path: "/ws" });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString()) as { _tag: string; id?: string; tag?: string; payload?: Record<string, unknown> };
      if (f._tag !== "Request") return;
      const ok = (value: unknown) => ws.send(JSON.stringify({ _tag: "Exit", requestId: f.id, exit: { _tag: "Success", value } }));
      if (f.tag === "server.getConfig") return ok({ providers, settings: { defaultThreadEnvMode: "local" } });
      if (f.tag === "orchestration.getArchivedShellSnapshot") return ok({ projects: [], threads: [] });
      if (f.tag === "orchestration.dispatchCommand") {
        if (fake.failDispatch !== undefined && --fake.failDispatch === 0) {
          fake.failDispatch = undefined;
          return ws.send(JSON.stringify({ _tag: "Exit", requestId: f.id, exit: { _tag: "Failure", cause: { _tag: "Fail", error: "boom" } } }));
        }
        const cmd = f.payload ?? {};
        commands.push(cmd);
        const create = (cmd.type === "thread.create" ? cmd : (cmd.bootstrap as { createThread?: Record<string, unknown> } | undefined)?.createThread) as Record<string, unknown> | undefined;
        if (create) threads.push({ id: String(cmd.threadId), projectId: String(create.projectId), title: String(create.title), createdAt: String(create.createdAt), archivedAt: null });
        const msg = cmd.message as { role: string; text: string } | undefined;
        if (msg) messages.set(String(cmd.threadId), [...(messages.get(String(cmd.threadId)) ?? []), msg]);
        return ok({ sequence: ++seq });
      }
      ws.send(JSON.stringify({ _tag: "Exit", requestId: f.id, exit: { _tag: "Failure", cause: { _tag: "Fail", error: `unhandled ${f.tag}` } } }));
    });
  });

  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const addr = http.address();
  const origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const server = { origin, descriptor: { environmentId: "fake-env", label: "fake", platform: { os: "darwin", arch: "arm64" }, serverVersion: "0.0.0", capabilities: {} }, source: "env" as const, isDesktopBackend: true, degraded: false };

  const fake: Fake = {
    origin, project, threads, messages, commands,
    ctx: { server, client: makeClient(server, "fake-token"), format: "json" },
    seed(title, prompt, secondsAgo) {
      const t: ShellThread = { id: `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`, projectId: project.id, title, createdAt: new Date(Date.now() - secondsAgo * 1000).toISOString(), archivedAt: null };
      threads.push(t);
      if (prompt !== undefined) messages.set(t.id, [{ role: "user", text: prompt }]);
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
