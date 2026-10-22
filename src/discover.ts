import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { T3_HOME, readConfig } from "./config.js";
import { CliError } from "./errors.js";

export interface EnvironmentDescriptor {
  environmentId: string;
  label: string;
  platform: { os: string; arch: string };
  serverVersion: string;
  /** Orchestrator protocol generation; absent on pre-0.1.0 (alpha, orchestrator V1) servers. */
  orchestrationProtocolVersion?: number;
  capabilities: Record<string, unknown>;
}

/**
 * Compatibility gate. T3 Code 0.1.0 (beta) replaced the orchestrator (V2): HTTP reads need the
 * `x-t3-orchestration-protocol: 2` header, the WebSocket needs `?orchestrationProtocol=2`, and every thread
 * command changed shape. Nothing in t3ctl speaks to the alphas any more, so we refuse them up front instead of
 * failing on the first request with an opaque 400/426.
 */
export const MIN_SERVER_VERSION = "0.1.0";
export const SUPPORTED_PROTOCOL = 2;
export const INCOMPATIBLE_EXIT = 7;

/** SemVer-ish compare on the numeric core only (`0.1.1-nightly.3` → 0.1.1). */
export function compareVersions(a: string, b: string): number {
  const num = (v: string) => v.replace(/^v/, "").split("-")[0].split(".").map((x) => Number.parseInt(x, 10) || 0);
  const [x, y] = [num(a), num(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface Compatibility { ok: boolean; reason?: string }

export function compatibility(d: EnvironmentDescriptor): Compatibility {
  if (typeof d.serverVersion !== "string" || !/^\d+\.\d+/.test(d.serverVersion)) return { ok: false, reason: `server did not report a version (got ${JSON.stringify(d.serverVersion)})` };
  if (compareVersions(d.serverVersion, MIN_SERVER_VERSION) < 0) return { ok: false, reason: `T3 Code ${d.serverVersion} is older than the minimum ${MIN_SERVER_VERSION} (the 0.0.x alphas use orchestrator V1, which t3ctl no longer speaks)` };
  if (d.orchestrationProtocolVersion === undefined) return { ok: false, reason: `T3 Code ${d.serverVersion} advertises no orchestration protocol version (expected ${SUPPORTED_PROTOCOL})` };
  if (d.orchestrationProtocolVersion !== SUPPORTED_PROTOCOL) return { ok: false, reason: `T3 Code ${d.serverVersion} speaks orchestration protocol ${d.orchestrationProtocolVersion}; this t3ctl supports ${SUPPORTED_PROTOCOL}` };
  return { ok: true };
}

/** Throw `incompatible_server` (exit 7) unless the server is one we can talk to. */
export function assertCompatible(server: Server): void {
  const c = compatibility(server.descriptor);
  if (c.ok) return;
  const d = server.descriptor;
  throw new CliError(
    "incompatible_server",
    `${c.reason}. Update T3 Code (${server.origin}) to ${MIN_SERVER_VERSION} or newer${d.orchestrationProtocolVersion !== undefined && d.orchestrationProtocolVersion > SUPPORTED_PROTOCOL ? ", or update t3ctl" : ""}.`,
    { origin: server.origin, serverVersion: d.serverVersion, orchestrationProtocolVersion: d.orchestrationProtocolVersion ?? null, minServerVersion: MIN_SERVER_VERSION, supportedProtocol: SUPPORTED_PROTOCOL },
    INCOMPATIBLE_EXIT,
  );
}

export interface Server {
  origin: string;
  descriptor: EnvironmentDescriptor;
  source: "config" | "env" | "server-runtime.json" | "probe";
  /** `capabilities.serverSelfUpdate === "desktop-managed"`: the backend the UI is connected to. */
  isDesktopBackend: boolean;
  /** True when we settled for a non-desktop server — writes will not show up live in the UI. */
  degraded: boolean;
}

const PORT_RANGE = Array.from({ length: 8 }, (_, i) => 3773 + i);
const PROBE_TIMEOUT_MS = 1500;
/** The desktop backend can be slow to answer under load; give the recorded origin more room before giving up. */
const RETRY_TIMEOUT_MS = 4000;
const RETRY_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 200;

export async function fetchDescriptor(origin: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<EnvironmentDescriptor | undefined> {
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

const toServer = (origin: string, descriptor: EnvironmentDescriptor, source: Server["source"]): Server => ({
  origin,
  descriptor,
  source,
  isDesktopBackend: isDesktopBackend(descriptor),
  degraded: !isDesktopBackend(descriptor),
});

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

/** Seams for the tests; production defaults talk to the real filesystem, network and clock. */
export interface DiscoveryDeps {
  probe: (origin: string, timeoutMs: number) => Promise<EnvironmentDescriptor | undefined>;
  runtimeOrigin: () => string | undefined;
  configOrigin: () => string | undefined;
  warn: (msg: string) => void;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: DiscoveryDeps = {
  probe: fetchDescriptor,
  runtimeOrigin: runtimeStateOrigin,
  configOrigin: () => readConfig().origin,
  warn: (msg) => process.stderr.write(msg),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const trim = (origin: string) => origin.replace(/\/$/, "");

/**
 * Resolution: --origin / T3CTL_ORIGIN wins (explicit). Otherwise probe 127.0.0.1:3773-3780 plus config.origin
 * and server-runtime.json in parallel, and PREFER the desktop-managed backend (the one the UI is connected to);
 * any other live server (the `t3 serve` background service) is a fallback. Two servers share one SQLite but
 * not one event bus, so dispatching to the wrong one leaves the UI stale. Never starts a server.
 *
 * If the first (fast, parallel) pass finds no desktop backend but server-runtime.json points at an origin we
 * never reached, that origin is retried with a longer timeout before we accept the fallback: under load the
 * desktop probe can simply time out, and silently downgrading to the background service is the worst outcome.
 */
export async function discoverServer(explicitOrigin?: string, deps: Partial<DiscoveryDeps> = {}): Promise<Server> {
  const d = { ...defaultDeps, ...deps };
  const env = explicitOrigin ?? process.env.T3CTL_ORIGIN;
  if (env) {
    const origin = trim(env);
    const descriptor = await d.probe(origin, 3000);
    if (!descriptor) throw new CliError("no_server", `No T3 Code server at ${origin}`, { origin });
    return toServer(origin, descriptor, "env");
  }
  const candidates = new Map<string, Server["source"]>();
  for (const port of PORT_RANGE) candidates.set(`http://127.0.0.1:${port}`, "probe");
  const cfgOrigin = d.configOrigin();
  if (cfgOrigin) candidates.set(trim(cfgOrigin), "config");
  const rt = d.runtimeOrigin();
  const rtOrigin = rt ? trim(rt) : undefined;
  if (rtOrigin) candidates.set(rtOrigin, "server-runtime.json");

  const found = (await Promise.all([...candidates].map(async ([origin, source]) => {
    const descriptor = await d.probe(origin, PROBE_TIMEOUT_MS);
    return descriptor ? toServer(origin, descriptor, source) : undefined;
  }))).filter((x): x is Server => !!x);

  const desktop = found.find((s) => s.isDesktopBackend);
  if (desktop) return desktop;

  // No desktop backend on the fast pass. If server-runtime.json points at a live pid whose origin never
  // answered, it is more likely slow than gone — retry it before settling for the background service.
  if (rtOrigin && !found.some((s) => s.origin === rtOrigin)) {
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      await d.sleep(RETRY_BACKOFF_MS * attempt);
      const descriptor = await d.probe(rtOrigin, RETRY_TIMEOUT_MS);
      if (descriptor) {
        const server = toServer(rtOrigin, descriptor, "server-runtime.json");
        if (server.isDesktopBackend) return server;
        found.push(server);
        break;
      }
    }
  }

  if (found.length === 0) {
    throw new CliError("no_server", `No running T3 Code server found (probed ${[...candidates.keys()].join(", ")}). Start the T3 Code app, or pass --origin.`, { probed: [...candidates.keys()] });
  }
  const fallback = found[0];
  d.warn(`t3ctl: no desktop backend found; using ${fallback.origin} (${String(fallback.descriptor.capabilities.serverSelfUpdate)}). The desktop UI will not show live updates.\n`);
  return fallback;
}
