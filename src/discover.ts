import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { T3_HOME, readConfig } from "./config.js";

export interface EnvironmentDescriptor {
  environmentId: string;
  label: string;
  platform: { os: string; arch: string };
  serverVersion: string;
  capabilities: Record<string, unknown>;
}

export interface Server {
  origin: string;
  descriptor: EnvironmentDescriptor;
  source: "config" | "env" | "server-runtime.json" | "probe";
}

const DEFAULT_DESKTOP_PORT = 3773;

export async function fetchDescriptor(origin: string, timeoutMs = 2000): Promise<EnvironmentDescriptor | undefined> {
  try {
    const r = await fetch(`${origin}/.well-known/t3/environment`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return undefined;
    const body = (await r.json()) as EnvironmentDescriptor;
    return body.environmentId ? body : undefined;
  } catch {
    return undefined;
  }
}

function runtimeStateOrigin(): string | undefined {
  // Written by `t3 serve`/desktop in newer builds; absent on some installs. Last-writer-wins
  // between desktop backend and background service, so it is a hint only.
  const p = join(T3_HOME, "userdata", "server-runtime.json");
  if (!existsSync(p)) return undefined;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { origin?: string; pid?: number };
    if (j.pid) {
      try { process.kill(j.pid, 0); } catch { return undefined; }
    }
    return j.origin;
  } catch {
    return undefined;
  }
}

/**
 * Resolution order: --origin flag / T3CTL_ORIGIN → config.origin → server-runtime.json → probe
 * 127.0.0.1:3773 (desktop backend). Never starts a server.
 */
export async function discoverServer(explicitOrigin?: string): Promise<Server> {
  const candidates: Array<{ origin: string; source: Server["source"] }> = [];
  const env = explicitOrigin ?? process.env.T3CTL_ORIGIN;
  if (env) candidates.push({ origin: env.replace(/\/$/, ""), source: "env" });
  const cfg = readConfig();
  if (cfg.origin) candidates.push({ origin: cfg.origin, source: "config" });
  const rt = runtimeStateOrigin();
  if (rt) candidates.push({ origin: rt, source: "server-runtime.json" });
  candidates.push({ origin: `http://127.0.0.1:${DEFAULT_DESKTOP_PORT}`, source: "probe" });

  for (const c of candidates) {
    const descriptor = await fetchDescriptor(c.origin);
    if (descriptor) return { origin: c.origin, descriptor, source: c.source };
  }
  throw new Error(
    `No running T3 Code server found (tried ${candidates.map((c) => c.origin).join(", ")}). ` +
      `Start the T3 Code app, or pass --origin.`,
  );
}
