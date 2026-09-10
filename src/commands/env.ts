import type { Command } from "commander";
import { discoverServer } from "../discover.js";
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
          `origin    ${server.origin}  (via ${server.source})`,
          `label     ${d.label}`,
          `env id    ${d.environmentId}`,
          `version   ${d.serverVersion}  ${d.platform.os}/${d.platform.arch}`,
          `caps      ${Object.entries(d.capabilities).filter(([, v]) => v === true).map(([k]) => k).join(", ")}`,
        ].join("\n"),
      );
    });
}
