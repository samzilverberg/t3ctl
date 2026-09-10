#!/usr/bin/env node
import { Command } from "commander";
import { registerEnv } from "./commands/env.js";
import { registerAuth } from "./commands/auth.js";
import { registerProjects } from "./commands/projects.js";
import { registerThreads } from "./commands/threads.js";

const program = new Command()
  .name("t3ctl")
  .description("Control an already-running T3 Code app from the terminal (read-only prototype)")
  .version("0.0.1")
  .option("--origin <url>", "server origin (default: discover; env T3CTL_ORIGIN)")
  .option("-f, --format <fmt>", "json|table (default: table on TTY, json otherwise / T3CTL_AGENT=1)")
  .showHelpAfterError();

registerEnv(program);
registerAuth(program);
registerProjects(program);
registerThreads(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`t3ctl: ${msg}\n`);
  process.exit(1);
});
