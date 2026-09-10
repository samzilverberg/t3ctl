import type { Command } from "commander";
import { discoverServer, fetchDescriptor, isDesktopBackend } from "../discover.js";
import { emit, pickFormat } from "../output.js";
import type { GlobalOpts } from "../context.js";

export function registerEnv(program: Command) {
  program
    .command("env")
    .description("Show the running T3 Code server this CLI targets (no auth needed)")
    .action(async () => {
      const g = program.opts<GlobalOpts>();
      const server = await discoverServer(g.origin);
      const d = server.descriptor;
      emit(pickFormat(g.format), { origin: server.origin, source: server.source, ...d }, () =>
        [
          `origin    ${server.origin}  (via ${server.source}${isDesktopBackend(d) ? ", desktop backend = what the UI uses" : ", NOT the desktop backend"})`,
          `label     ${d.label}`,
          `env id    ${d.environmentId}`,
          `version   ${d.serverVersion}  ${d.platform.os}/${d.platform.arch}`,
          `caps      ${Object.entries(d.capabilities).filter(([, v]) => v === true).map(([k]) => k).join(", ")}`,
        ].join("\n"),
      );
    });

  program
    .command("servers")
    .description("Probe 127.0.0.1:3773-3780 and list every running T3 Code server (desktop backend vs background service)")
    .action(async () => {
      const g = program.opts<GlobalOpts>();
      const rows = (await Promise.all(Array.from({ length: 8 }, (_, i) => 3773 + i).map(async (port) => {
        const origin = `http://127.0.0.1:${port}`; const d = await fetchDescriptor(origin);
        return d ? { origin, kind: isDesktopBackend(d) ? "desktop-backend (UI)" : String(d.capabilities.serverSelfUpdate ?? "server"), version: d.serverVersion, environmentId: d.environmentId } : undefined;
      }))).filter((x): x is NonNullable<typeof x> => !!x);
      emit(pickFormat(g.format), rows, () => rows.map((r) => `${r.origin}  ${r.kind}  v${r.version}`).join("\n") || "(none)");
    });
}
