import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverServer, isDesktopBackend, type DiscoveryDeps, type EnvironmentDescriptor } from "../src/discover.js";

delete process.env.T3CTL_ORIGIN;   // discovery must be driven by the injected deps only

const DESKTOP = "http://127.0.0.1:3774";
const BOOT = "http://127.0.0.1:3773";

const descriptor = (selfUpdate: string): EnvironmentDescriptor => ({
  environmentId: `env-${selfUpdate}`,
  label: selfUpdate,
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "1.2.3",
  capabilities: { serverSelfUpdate: selfUpdate, orchestration: true },
});

const desktopDescriptor = descriptor("desktop-managed");
const bootDescriptor = descriptor("self-managed");

/** `probe` answers from a map of origin → descriptor; every probe is recorded so tests can assert retries. */
function deps(
  live: Record<string, EnvironmentDescriptor | undefined>,
  extra: Partial<DiscoveryDeps> = {},
): DiscoveryDeps & { probes: Array<{ origin: string; timeoutMs: number }>; warnings: string[] } {
  const probes: Array<{ origin: string; timeoutMs: number }> = [];
  const warnings: string[] = [];
  return {
    probes,
    warnings,
    probe: async (origin, timeoutMs) => { probes.push({ origin, timeoutMs }); return live[origin]; },
    runtimeOrigin: () => undefined,
    configOrigin: () => undefined,
    warn: (m) => { warnings.push(m); },
    sleep: async () => {},
    ...extra,
  };
}

test("isDesktopBackend keys off serverSelfUpdate", () => {
  assert.equal(isDesktopBackend(desktopDescriptor), true);
  assert.equal(isDesktopBackend(bootDescriptor), false);
});

test("desktop backend wins when both servers are live", async () => {
  const d = deps({ [BOOT]: bootDescriptor, [DESKTOP]: desktopDescriptor });
  const s = await discoverServer(undefined, d);
  assert.equal(s.origin, DESKTOP);
  assert.equal(s.isDesktopBackend, true);
  assert.equal(s.degraded, false);
  assert.deepEqual(d.warnings, []);
});

test("only the boot service live → degraded fallback plus a stderr warning", async () => {
  const d = deps({ [BOOT]: bootDescriptor });
  const s = await discoverServer(undefined, d);
  assert.equal(s.origin, BOOT);
  assert.equal(s.isDesktopBackend, false);
  assert.equal(s.degraded, true);
  assert.equal(s.source, "probe");
  assert.match(d.warnings.join(""), /no desktop backend found/);
});

test("happy path does not retry the runtime-state origin", async () => {
  const d = deps({ [BOOT]: bootDescriptor, [DESKTOP]: desktopDescriptor }, { runtimeOrigin: () => DESKTOP });
  const s = await discoverServer(undefined, d);
  assert.equal(s.origin, DESKTOP);
  assert.equal(d.probes.filter((p) => p.origin === DESKTOP).length, 1);
});

test("a timed-out desktop probe is retried, with a longer timeout, before falling back", async () => {
  let attempts = 0;
  const slept: number[] = [];
  const d = deps({ [BOOT]: bootDescriptor }, {
    runtimeOrigin: () => `${DESKTOP}/`,
    sleep: async (ms) => { slept.push(ms); },
  });
  const inner = d.probe;
  d.probe = async (origin, timeoutMs) => {
    await inner(origin, timeoutMs);
    if (origin !== DESKTOP) return timeoutMs === 1500 ? bootDescriptor : undefined;
    return ++attempts >= 2 ? desktopDescriptor : undefined;   // first probe times out, the retry succeeds
  };
  const s = await discoverServer(undefined, d);
  assert.equal(s.origin, DESKTOP);
  assert.equal(s.source, "server-runtime.json");
  assert.equal(s.degraded, false);
  assert.equal(attempts, 2);
  assert.ok(d.probes.some((p) => p.origin === DESKTOP && p.timeoutMs > 1500), "retry should use a longer timeout");
  assert.deepEqual(slept, [200]);
  assert.deepEqual(d.warnings, []);
});

test("retries are bounded; a genuinely dead desktop still falls back once", async () => {
  const d = deps({ [BOOT]: bootDescriptor }, { runtimeOrigin: () => DESKTOP });
  const s = await discoverServer(undefined, d);
  assert.equal(s.origin, BOOT);
  assert.equal(s.degraded, true);
  assert.equal(d.probes.filter((p) => p.origin === DESKTOP).length, 3);   // 1 fast pass + 2 retries
  assert.match(d.warnings.join(""), /no desktop backend found/);
});

test("the retry also rescues the only live server when the fast pass found nothing", async () => {
  let attempts = 0;
  const d = deps({}, { runtimeOrigin: () => DESKTOP });
  d.probe = async (origin) => (origin === DESKTOP && ++attempts >= 2 ? desktopDescriptor : undefined);
  const s = await discoverServer(undefined, d);
  assert.equal(s.origin, DESKTOP);
  assert.equal(s.degraded, false);
});

test("nothing anywhere → a helpful error, not a hang", async () => {
  const d = deps({}, { runtimeOrigin: () => DESKTOP });
  await assert.rejects(discoverServer(undefined, d), /No running T3 Code server found/);
});

test("an explicit origin is taken as-is and still reports degraded", async () => {
  const d = deps({ [BOOT]: bootDescriptor, [DESKTOP]: desktopDescriptor });
  const s = await discoverServer(`${BOOT}/`, d);
  assert.equal(s.origin, BOOT);
  assert.equal(s.source, "env");
  assert.equal(s.degraded, true);
  assert.deepEqual(d.probes.map((p) => p.origin), [BOOT]);   // explicit wins: no probing
});

test("config.origin is probed and can be the desktop backend", async () => {
  const cfg = "http://127.0.0.1:9999";
  const d = deps({ [BOOT]: bootDescriptor, [cfg]: desktopDescriptor }, { configOrigin: () => `${cfg}/` });
  const s = await discoverServer(undefined, d);
  assert.equal(s.origin, cfg);
  assert.equal(s.source, "config");
  assert.equal(s.degraded, false);
});
