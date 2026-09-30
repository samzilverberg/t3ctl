#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
import { registerEnv } from "./commands/env.js";
import { registerAuth } from "./commands/auth.js";
import { registerProjects } from "./commands/projects.js";
import { registerThreads } from "./commands/threads.js";
import { registerModels } from "./commands/models.js";
import { registerSchedule } from "./commands/schedule.js";
import { CliError } from "./errors.js";
import { pickFormat } from "./output.js";

const program = new Command()
  .name("t3ctl")
  .description("Control an already-running T3 Code app from the terminal ")
  .version(pkg.version)
  .option("--origin <url>", "server origin (default: discover; env T3CTL_ORIGIN)")
  .option("-f, --format <fmt>", "json|table (default: table on TTY, json otherwise / T3CTL_AGENT=1)")
  .option("--no-auto-pair", "fail instead of re-pairing automatically when the stored token is missing/expired/insufficient")
  .showHelpAfterError()
  // Throw instead of exiting on usage errors so they get the same JSON error shape (inherited by subcommands).
  .exitOverride();

registerEnv(program);
registerAuth(program);
registerProjects(program);
registerThreads(program);
registerModels(program);
registerSchedule(program);

/**
 * Every failure: message on stderr, exit code ≥ 1, and in JSON mode `{"error": {code, message, ...details}}` on
 * stdout. `code` is the CliError code, `usage` for commander parse errors, `error` for anything unclassified.
 */
program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof CommanderError && err.exitCode === 0) process.exit(0); // --help / --version
  const usage = err instanceof CommanderError;
  const msg = usage ? err.message.replace(/^error: /, "") : err instanceof Error ? err.message : String(err);
  const code = err instanceof CliError ? err.code : usage ? "usage" : "error";
  if (pickFormat(program.opts<{ format?: string }>().format) === "json") {
    const details = err instanceof CliError ? err.details : usage ? { commanderCode: err.code } : {};
    process.stdout.write(JSON.stringify({ error: Object.assign({ code, message: msg }, details, { code, message: msg }) }, null, 2) + "\n");
  }
  if (!usage) process.stderr.write(`t3ctl: ${msg}\n`); // commander already printed usage errors
  process.exit(err instanceof CliError ? err.exitCode : usage ? err.exitCode || 1 : 1);
});
