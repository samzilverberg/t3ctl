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

const PORT_RANGE = Array.from({ length: 8 }, (_, i) => 3773 + i);

export async function fetchDescriptor(origin: string, timeoutMs = 1500): Promise<EnvironmentDescriptor | undefined> {
  try {
    const r = await fetch(`${origin}/.well-known/t3/environment`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return undefined;
    const body = (await r.json()) as EnvironmentDescriptor;
    return body.environmentId ? body : undefined;
  } catch {
    return undefined;
  }
}

/** The desktop UI only sees live events from its own embedded backend, which advertises `desktop-managed`. */
export const isDesktopBackend = (d: EnvironmentDescriptor) => d.capabilities.serverSelfUpdate === "desktop-managed";

function runtimeStateOrigin(): string | undefined {
  const p = join(T3_HOME, "userdata", "server-runtime.json");
  if (!existsSync(p)) return undefined;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { origin?: string; pid?: number };
    if (j.pid) { try { process.kill(j.pid, 0); } catch { return undefined; } }
    return j.origin;
  } catch {
    return undefined;
  }
}

/**
 * Resolution: --origin / T3CTL_ORIGIN wins (explicit). Otherwise probe 127.0.0.1:3773-3780 plus config.origin
 * and server-runtime.json in parallel, and PREFER the desktop-managed backend (the one the UI is connected to);
 * any other live server (the `t3 serve` background service) is a fallback. Two servers share one SQLite but
 * not one event bus, so dispatching to the wrong one leaves the UI stale. Never starts a server.
 */
export async function discoverServer(explicitOrigin?: string): Promise<Server> {
  const env = explicitOrigin ?? process.env.T3CTL_ORIGIN;
  if (env) {
    const origin = env.replace(/\/$/, "");
    const descriptor = await fetchDescriptor(origin, 3000);
    if (!descriptor) throw new Error(`No T3 Code server at ${origin}`);
    return { origin, descriptor, source: "env" };
  }
  const cfg = readConfig();
  const candidates = new Map<string, Server["source"]>();
  for (const port of PORT_RANGE) candidates.set(`http://127.0.0.1:${port}`, "probe");
  if (cfg.origin) candidates.set(cfg.origin.replace(/\/$/, ""), "config");
  const rt = runtimeStateOrigin();
  if (rt) candidates.set(rt.replace(/\/$/, ""), "server-runtime.json");

  const found = (await Promise.all([...candidates].map(async ([origin, source]) => {
    const descriptor = await fetchDescriptor(origin);
    return descriptor ? ({ origin, descriptor, source } as Server) : undefined;
  }))).filter((x): x is Server => !!x);
  if (found.length === 0) {
    throw new Error(`No running T3 Code server found (probed ${[...candidates.keys()].join(", ")}). Start the T3 Code app, or pass --origin.`);
  }
  const desktop = found.find((s) => isDesktopBackend(s.descriptor));
  if (desktop) return desktop;
  const fallback = found[0];
  process.stderr.write(`t3ctl: no desktop backend found; using ${fallback.origin} (${String(fallback.descriptor.capabilities.serverSelfUpdate)}). The desktop UI will not show live updates.\n`);
  return fallback;
}
