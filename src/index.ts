#!/usr/bin/env node
import { Command } from "commander";
import { registerEnv } from "./commands/env.js";
import { registerAuth } from "./commands/auth.js";
import { registerProjects } from "./commands/projects.js";
import { registerThreads } from "./commands/threads.js";
import { registerModels } from "./commands/models.js";

const program = new Command()
  .name("t3ctl")
  .description("Control an already-running T3 Code app from the terminal ")
  .version("0.0.1")
  .option("--origin <url>", "server origin (default: discover; env T3CTL_ORIGIN)")
  .option("-f, --format <fmt>", "json|table (default: table on TTY, json otherwise / T3CTL_AGENT=1)")
  .option("--no-auto-pair", "fail instead of re-pairing automatically when the stored token is missing/expired/insufficient")
  .showHelpAfterError();

registerEnv(program);
registerAuth(program);
registerProjects(program);
registerThreads(program);
registerModels(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`t3ctl: ${msg}\n`);
  process.exit(1);
});
