import type { Command } from "commander";
import { hostname } from "node:os";
import { discoverServer } from "../discover.js";
import { forget, pair } from "../auth.js";
import { connect, type GlobalOpts } from "../context.js";
import { api } from "../http.js";
import { emit, pickFormat } from "../output.js";
import { readConfig, CONFIG_PATH } from "../config.js";

export function registerAuth(program: Command) {
  const auth = program.command("auth").description("Pair with the running app and inspect the stored session");

  auth
    .command("pair")
    .description("Mint a pairing token via the installed `t3` CLI, exchange it for a bearer session, store it in the macOS Keychain")
    .option("--label <label>", "connection label shown in T3 Code → Connections", `t3ctl@${hostname()}`)
    .option("--operate", "also request orchestration:operate (needed for future write commands). Default is read-only.", false)
    .action(async (o: { label: string; operate: boolean }) => {
      const g = program.opts<GlobalOpts>();
      const server = await discoverServer(g.origin);
      const res = await pair(server, o);
      emit(pickFormat(g.format), { origin: server.origin, environmentId: server.descriptor.environmentId, ...res, config: CONFIG_PATH }, () =>
        `Paired with ${server.descriptor.label} (${server.origin})\nscopes   ${res.scopes.join(" ")}\nexpires  ${res.expiresAt}\ntoken    macOS Keychain (service t3ctl)\nconfig   ${CONFIG_PATH}`);
    });

  auth
    .command("status")
    .description("Show the server's view of our session (GET /api/auth/session)")
    .action(async () => {
      const g = program.opts<GlobalOpts>();
      const { client, format, server } = await connect(g);
      const s = await api.session(client);
      const cfg = readConfig();
      emit(format, { origin: server.origin, ...s, storedExpiresAt: cfg.expiresAt }, () =>
        `origin         ${server.origin}\nauthenticated  ${s.authenticated}\nscopes         ${(s.scopes ?? []).join(" ")}\nmethod         ${s.sessionMethod ?? ""}\nexpires        ${s.expiresAt ?? cfg.expiresAt ?? ""}`);
    });

  auth
    .command("forget")
    .description("Delete the stored token from the Keychain (does not revoke it server-side; do that in T3 Code → Connections)")
    .action(async () => {
      const g = program.opts<GlobalOpts>();
      const server = await discoverServer(g.origin);
      const ok = forget(server);
      emit(pickFormat(g.format), { removed: ok }, () => (ok ? "Token removed from Keychain." : "No stored token found."));
    });
}
