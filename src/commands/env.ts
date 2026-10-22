import type { Command } from "commander";
import { compatibility, discoverServer, fetchDescriptor, isDesktopBackend, MIN_SERVER_VERSION, SUPPORTED_PROTOCOL } from "../discover.js";
import { emit, pickFormat } from "../output.js";
import type { GlobalOpts } from "../context.js";

export function registerEnv(program: Command) {
  program
    .command("env")
    .description("Show the running T3 Code server this CLI targets (no auth needed). Exit 7 when its version is unsupported.")
    .action(async () => {
      const g = program.opts<GlobalOpts>();
      const server = await discoverServer(g.origin);
      const d = server.descriptor;
      const compat = compatibility(d);
      emit(
        pickFormat(g.format),
        { origin: server.origin, source: server.source, isDesktopBackend: server.isDesktopBackend, degraded: server.degraded, supported: compat.ok, ...(compat.ok ? {} : { unsupportedReason: compat.reason }), minServerVersion: MIN_SERVER_VERSION, supportedProtocol: SUPPORTED_PROTOCOL, ...d },
        () =>
          [
            `origin    ${server.origin}  (via ${server.source}${server.isDesktopBackend ? ", desktop backend = what the UI uses" : ", NOT the desktop backend — the UI will not show live updates"})`,
            `label     ${d.label}`,
            `env id    ${d.environmentId}`,
            `version   ${d.serverVersion}  protocol ${d.orchestrationProtocolVersion ?? "-"}  ${d.platform.os}/${d.platform.arch}  ${compat.ok ? "(supported)" : `UNSUPPORTED: ${compat.reason}`}`,
            `caps      ${Object.entries(d.capabilities).filter(([, v]) => v === true).map(([k]) => k).join(", ")}`,
          ].join("\n"),
      );
      if (!compat.ok) { process.stderr.write(`t3ctl: ${compat.reason}. t3ctl needs T3 Code ≥ ${MIN_SERVER_VERSION}.\n`); process.exitCode = 7; }
    });

  program
    .command("servers")
    .description("Probe 127.0.0.1:3773-3780 and list every running T3 Code server (desktop backend vs background service)")
    .action(async () => {
      const g = program.opts<GlobalOpts>();
      const rows = (await Promise.all(Array.from({ length: 8 }, (_, i) => 3773 + i).map(async (port) => {
        const origin = `http://127.0.0.1:${port}`; const d = await fetchDescriptor(origin);
        return d ? { origin, kind: isDesktopBackend(d) ? "desktop-backend (UI)" : String(d.capabilities.serverSelfUpdate ?? "server"), version: d.serverVersion, protocol: d.orchestrationProtocolVersion ?? null, supported: compatibility(d).ok, environmentId: d.environmentId } : undefined;
      }))).filter((x): x is NonNullable<typeof x> => !!x);
      emit(pickFormat(g.format), rows, () => rows.map((r) => `${r.origin}  ${r.kind}  v${r.version}${r.supported ? "" : "  (unsupported)"}`).join("\n") || "(none)");
    });
}
