import WebSocket from "ws";
import type { Server } from "./discover.js";

/**
 * Minimal client for Effect RPC (effect@4 `unstable/rpc`) over WebSocket with JSON serialization,
 * matching what the T3 Code server exposes at GET /ws. One JSON object per WS frame (server may
 * batch as an array). Streams arrive as Chunk frames that must be Ack'd; Exit terminates a request.
 *
 * Auth: bearer token in the upgrade `Authorization` header (Node can set it; browsers use wsTicket).
 */
type Frame =
  | { _tag: "Chunk"; requestId: string; values: unknown[] }
  | { _tag: "Exit"; requestId: string; exit: { _tag: "Success"; value: unknown } | { _tag: "Failure"; cause: unknown } }
  | { _tag: "Defect"; defect: unknown }
  | { _tag: "Pong" }
  | { _tag: "ClientProtocolError"; error: unknown };

interface Pending {
  onChunk: (values: unknown[]) => void;
  onExit: (exit: Extract<Frame, { _tag: "Exit" }>["exit"]) => void;
}

export class RpcSocket {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private ready: Promise<void>;

  constructor(server: Server, token: string, clientSurface = "cli") {
    const url = new URL("/ws", server.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("clientSurface", clientSurface);
    url.searchParams.set("clientDeviceType", "desktop");
    url.searchParams.set("clientOs", process.platform);
    this.ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, perMessageDeflate: true });
    this.ready = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", (e) => reject(e));
      this.ws.once("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => reject(new Error(`ws upgrade rejected: ${res.statusCode} ${body}`)));
      });
    });
    this.ws.on("message", (data) => this.onMessage(data.toString()));
    this.ws.on("close", (code, reason) => {
      for (const p of this.pending.values()) p.onExit({ _tag: "Failure", cause: { _tag: "Die", defect: `socket closed ${code} ${reason}` } });
      this.pending.clear();
    });
  }

  private send(frame: unknown) { this.ws.send(JSON.stringify(frame)); }

  private onMessage(raw: string) {
    const decoded = JSON.parse(raw) as Frame | Frame[];
    for (const f of Array.isArray(decoded) ? decoded : [decoded]) {
      if (f._tag === "Pong") continue;
      if (f._tag === "Defect" || f._tag === "ClientProtocolError") {
        for (const p of this.pending.values()) p.onExit({ _tag: "Failure", cause: f });
        this.pending.clear();
        continue;
      }
      const p = this.pending.get(f.requestId);
      if (!p) continue;
      if (f._tag === "Chunk") {
        p.onChunk(f.values);
        this.send({ _tag: "Ack", requestId: f.requestId });
      } else if (f._tag === "Exit") {
        this.pending.delete(f.requestId);
        p.onExit(f.exit);
      }
    }
  }

  private start(tag: string, payload: unknown, p: Pending): string {
    const id = String(this.nextId++);
    this.pending.set(id, p);
    this.send({ _tag: "Request", id, tag, payload, headers: [] });
    return id;
  }

  /** Unary RPC. */
  async request<T>(tag: string, payload: unknown): Promise<T> {
    await this.ready;
    return new Promise<T>((resolve, reject) => {
      this.start(tag, payload, {
        onChunk: () => {},
        onExit: (exit) => (exit._tag === "Success" ? resolve(exit.value as T) : reject(new RpcFailure(tag, exit.cause))),
      });
    });
  }

  /** Streaming RPC (`stream: true` methods such as orchestration.subscribeThread). */
  async *subscribe<T>(tag: string, payload: unknown, signal?: AbortSignal): AsyncGenerator<T> {
    await this.ready;
    const queue: T[] = [];
    let done = false;
    let failure: unknown;
    let wake: (() => void) | undefined;
    const id = this.start(tag, payload, {
      onChunk: (values) => { queue.push(...(values as T[])); wake?.(); },
      onExit: (exit) => { done = true; if (exit._tag === "Failure") failure = exit.cause; wake?.(); },
    });
    const onAbort = () => { this.send({ _tag: "Interrupt", requestId: id }); done = true; wake?.(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      while (true) {
        if (queue.length) { yield queue.shift() as T; continue; }
        if (done) break;
        await new Promise<void>((r) => (wake = r));
        wake = undefined;
      }
      if (failure) throw new RpcFailure(tag, failure);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.pending.delete(id);
    }
  }

  close() { try { this.send({ _tag: "Eof" }); } catch { /* ignore */ } this.ws.close(); }
}

export class RpcFailure extends Error {
  constructor(public tag: string, public cause: unknown) {
    super(`${tag} failed: ${JSON.stringify(cause).slice(0, 500)}`);
  }
}
