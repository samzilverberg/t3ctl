import type { Command } from "commander";
import { connect, type GlobalOpts } from "../context.js";
import { fetchProviders } from "../models.js";
import { emit, renderTable } from "../output.js";
import { modelAliases } from "../config.js";

export function registerModels(program: Command) {
  program
    .command("models")
    .description("List models available on enabled providers, with their option values (effort etc.)")
    .option("-a, --all", "include legacy models and disabled providers", false)
    .action(async (o: { all: boolean }) => {
      const { client, server, format } = await connect(program.opts<GlobalOpts>());
      const providers = await fetchProviders(server, client.token);
      const aliases = modelAliases();
      const rows = providers
        .filter((p) => o.all || p.enabled)
        .flatMap((p) => p.models.filter((m) => o.all || !m.isLegacy).map((m) => {
          const opt = (id: string) => (m.capabilities?.optionDescriptors ?? []).find((d) => d.id === id);
          return {
            instanceId: p.instanceId,
            provider: p.displayName,
            status: p.status ?? "",
            model: m.slug,
            aliases: [...Object.entries(aliases).filter(([, v]) => v === m.slug).map(([k]) => `${k}*`), ...(m.aliases ?? [])].join(","),
            effort: (opt("effort")?.options ?? []).map((x) => x.id + (x.isDefault ? "*" : "")).join("|"),
            contextWindow: (opt("contextWindow")?.options ?? []).map((x) => x.id + (x.isDefault ? "*" : "")).join("|"),
            fastMode: Boolean(opt("fastMode")),
            legacy: Boolean(m.isLegacy),
          };
        }));
      emit(format, rows, () => renderTable(rows, ["instanceId", "status", "model", "aliases", "effort", "contextWindow", "fastMode"]) + "\n(* = default option / t3ctl alias)");
    });
}
