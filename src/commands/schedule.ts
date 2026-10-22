import type { Command } from "commander";
import { execFileSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { connect, withAuthRetry, type Ctx, type GlobalOpts } from "../context.js";
import { api, rpc, type ShellProject, type ShellThread } from "../http.js";
import { fetchConfig, type ModelSelection, type ServerConfig } from "../models.js";
import { ago, emit, pickFormat, renderTable, short } from "../output.js";
import { applyDefaults, envModeOf, matchProject, matchThread, resolveNewModel, resolveTurnModel, INTERACTION_MODES, RUNTIME_MODES, type InteractionMode, type RuntimeMode } from "../ops.js";
import { uuid } from "../ids.js";
import { CliError } from "../errors.js";
import { convertLegacyJob, cronToSchedule, describeSchedule, fixedTimeSchedule, intervalSchedule, LEGACY_LOG_PATH, LEGACY_SCHEDULE_PATH, matchTask, readLegacyJobs, type Schedule, type ScheduledTask } from "../schedule.js";
import * as launchd from "../launchd.js";
import { readFileSync } from "node:fs";

/**
 * `t3ctl schedule` drives T3 Code's built-in scheduler (0.1+): one source of truth, shared with the desktop UI and
 * the MCP `schedule_task` tools. Tasks persist in the app's own database and fire from the server, with or without
 * a client around. t3ctl adds nothing of its own on top (no local file, no launchd ticker).
 */
export function registerSchedule(program: Command) {
  const sched = program.command("schedule").description("Recurring tasks run by T3 Code's built-in scheduler (new thread per run, or a message into one thread)");

  const scheduleFlags = (c: Command) => c
    .option("--every <dur>", "run every <dur> (≥ 1m: 30m, 2h, 1d)")
    .option("--at <HH:MM>", "run daily at this local time (server's time zone)")
    .option("--days <spec>", "with --at: mon-fri, weekdays, weekends, mon,wed,fri, 0-6 (0 = Sunday)")
    .option("--cron <expr>", "convenience: a cron expression T3 can express (*/N * * * *, M H * * D, @hourly, @daily, @weekly)")
    .option("--webhook", "run on each request to the task's webhook URL (prompt may use {{body.x}} placeholders)", false);

  const targetFlags = (c: Command) => c
    .option("-m, --model <ref>", "model slug or alias (default: project default → server default)")
    .option("-e, --effort <level>", "reasoning effort")
    .option("-t, --title <title>", "task title (default: first line of the prompt)")
    .option("--runtime-mode <mode>", RUNTIME_MODES.join("|"))
    .option("--interaction-mode <mode>", INTERACTION_MODES.join("|"))
    .option("--env <mode>", "worktree|local for new-thread tasks (default: project/server setting)")
    .option("--base <ref>", "base ref for worktree tasks (default: the project checkout's current branch)")
    .option("--branch <name>", "fixed worktree branch name (default: server picks one per run)");

  targetFlags(scheduleFlags(sched
    .command("add")
    .argument("<prompt>", "prompt text, or - to read it from stdin")
    .description("Create a scheduled task. Pick exactly one of --every / --at / --cron / --webhook, and -p (new thread per run) or --thread (message into that thread).")
    .option("-p, --project <ref>", "project: every run starts a new thread here")
    .option("--thread <ref>", "instead, send the prompt into this existing thread on every run")
    .option("--disabled", "create paused", false)))
    .action(async (promptArg: string, o: AddOpts) => {
      const g = program.opts<GlobalOpts>();
      if (!o.project === !o.thread) throw new CliError("invalid_option", "pass exactly one of -p <project> or --thread <ref>", { option: "project" });
      const text = promptArg === "-" ? readFileSync(0, "utf8").trim() : promptArg;
      if (!text) throw new CliError("invalid_option", "empty prompt", { option: "prompt" });
      const schedule = scheduleFromFlags(o);
      if (!schedule) throw new CliError("invalid_option", "pass one of --every <dur>, --at HH:MM [--days …], --cron <expr>, --webhook", { option: "schedule" });
      const ctx = await connect(g, { write: true });
      const shell = await withAuthRetry(ctx, g, api.shell);
      const config = await fetchConfig(ctx.server, ctx.client.token);
      const target = await resolveTarget(ctx, shell, config, o);
      const input = {
        commandId: uuid(), title: (o.title ?? text.split("\n")[0]).trim().slice(0, 80) || "Scheduled task", prompt: text, enabled: !o.disabled, schedule,
        ...target, createdBy: "user", creationSource: "server",
      };
      const { task } = await withAuthRetry(ctx, g, (c) => rpc<{ task: ScheduledTask }>(c, "scheduledTasks.upsert", input));
      emit(ctx.format, task, () => `scheduled ${task.id}  ${describeSchedule(task.schedule)}  next ${task.nextRunAt ?? "-"}${task.webhook?.url ? `\nwebhook ${task.webhook.url}` : task.schedule.type === "webhook" ? "\nwebhook URL needs T3 Connect remote access" : ""}`);
    });

  sched
    .command("list", { isDefault: true })
    .description("List scheduled tasks")
    .option("-p, --project <ref>", "only this project")
    .action(async (o: { project?: string }) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g);
      const [shell, { tasks }] = await Promise.all([withAuthRetry(ctx, g, api.shell), withAuthRetry(ctx, g, (c) => rpc<{ tasks: ScheduledTask[] }>(c, "scheduledTasks.list", {}))]);
      const projects = new Map(shell.projects.map((p) => [p.id, p.title]));
      let list = tasks;
      if (o.project) { const p = matchProject(shell.projects, o.project); list = list.filter((t) => t.projectId === p.id); }
      list = [...list].sort((a, b) => (a.nextRunAt ?? "~").localeCompare(b.nextRunAt ?? "~"));
      const legacy = legacyState();
      emit(ctx.format, { tasks: list.map((t) => ({ ...t, projectTitle: projects.get(t.projectId) ?? "" })), ...(legacy ? { legacy } : {}) }, () =>
        renderTable(list.map((t) => ({
          id: short(t.id), on: t.enabled ? "on" : "off", schedule: describeSchedule(t.schedule), target: t.threadId ? `→ ${short(t.threadId)}` : `new @${projects.get(t.projectId) ?? short(t.projectId)}`,
          model: `${t.modelSelection.model}${effort(t.modelSelection) ? "@" + effort(t.modelSelection) : ""}`, title: t.title.slice(0, 40), next: t.nextRunAt ? ago(t.nextRunAt).replace(/^/, "in ") : "-", last: t.lastRunStatus === "never" ? "" : `${t.lastRunStatus} ${t.lastRunAt ? ago(t.lastRunAt) + " ago" : ""}${t.lastRunError ? " (" + t.lastRunError.slice(0, 40) + ")" : ""}`, runs: t.runCount,
        })), ["id", "on", "schedule", "target", "model", "title", "next", "last", "runs"]) + (legacy ? `\n\nlegacy t3ctl scheduler still present (${legacy.pendingJobs} pending job(s)${legacy.tickerInstalled ? ", launchd ticker installed" : ""}); run \`t3ctl schedule migrate\`` : ""));
    });

  sched
    .command("show <ref>")
    .description("Show one task (full JSON)")
    .action(async (ref: string) => {
      const ctx = await connect(program.opts<GlobalOpts>());
      const task = await findTask(ctx, program.opts<GlobalOpts>(), ref);
      emit(ctx.format, task, () => JSON.stringify(task, null, 2));
    });

  targetFlags(scheduleFlags(sched
    .command("update <ref>")
    .argument("[prompt]", "new prompt text, or - to read it from stdin")
    .description("Change a task's schedule, prompt, title, model or modes (unspecified fields are kept)")))
    .action(async (ref: string, promptArg: string | undefined, o: UpdateOpts) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g, { write: true });
      const existing = await findTask(ctx, g, ref);
      const text = promptArg === "-" ? readFileSync(0, "utf8").trim() : promptArg;
      const schedule = scheduleFromFlags(o) ?? existing.schedule;
      let modelSelection: ModelSelection = existing.modelSelection;
      if (o.model || o.effort) {
        const shell = await withAuthRetry(ctx, g, api.shell);
        const project = shell.projects.find((p) => p.id === existing.projectId);
        if (!project) throw new CliError("project_not_found", `task's project ${existing.projectId} no longer exists`, { ref: existing.projectId });
        modelSelection = (await resolveNewModel(ctx, project, { model: o.model ?? `${existing.modelSelection.instanceId}/${existing.modelSelection.model}`, effort: o.effort })).modelSelection;
      }
      const d = applyDefaults({ runtimeMode: (o.runtimeMode ?? existing.runtimeMode) as RuntimeMode, interactionMode: (o.interactionMode ?? existing.interactionMode) as InteractionMode });
      const input = {
        id: existing.id, requireExisting: true, commandId: uuid(),
        title: o.title ?? existing.title, prompt: text ?? existing.prompt, enabled: existing.enabled, schedule,
        projectId: existing.projectId, threadId: existing.threadId, workspaceStrategy: existing.workspaceStrategy, modelSelection,
        runtimeMode: d.runtimeMode, interactionMode: d.interactionMode, createdBy: existing.createdBy, creationSource: existing.creationSource,
      };
      const { task } = await withAuthRetry(ctx, g, (c) => rpc<{ task: ScheduledTask }>(c, "scheduledTasks.upsert", input));
      emit(ctx.format, task, () => `updated ${task.id}  ${describeSchedule(task.schedule)}  next ${task.nextRunAt ?? "-"}`);
    });

  for (const [name, enabled] of [["enable", true], ["disable", false]] as const) {
    sched.command(`${name} <ref>`).description(`${name === "enable" ? "Resume" : "Pause"} a task`).action(async (ref: string) => {
      const g = program.opts<GlobalOpts>();
      const ctx = await connect(g, { write: true });
      const existing = await findTask(ctx, g, ref);
      const { task } = await withAuthRetry(ctx, g, (c) => rpc<{ task: ScheduledTask }>(c, "scheduledTasks.setEnabled", { id: existing.id, enabled }));
      emit(ctx.format, task, () => `${name}d ${task.id}  next ${task.nextRunAt ?? "-"}`);
    });
  }

  sched.command("remove <ref>").alias("delete").description("Delete a task").action(async (ref: string) => {
    const g = program.opts<GlobalOpts>();
    const ctx = await connect(g, { write: true });
    const existing = await findTask(ctx, g, ref);
    const res = await withAuthRetry(ctx, g, (c) => rpc<{ id: string }>(c, "scheduledTasks.delete", { id: existing.id }));
    emit(ctx.format, { ...res, title: existing.title }, () => `removed ${res.id} (${existing.title})`);
  });

  sched.command("run <ref>").description("Run a task now (its next scheduled run is unaffected)").action(async (ref: string) => {
    const g = program.opts<GlobalOpts>();
    const ctx = await connect(g, { write: true });
    const existing = await findTask(ctx, g, ref);
    const { task } = await withAuthRetry(ctx, g, (c) => rpc<{ task: ScheduledTask }>(c, "scheduledTasks.runNow", { id: existing.id }));
    emit(ctx.format, task, () => `run requested for ${task.id}  last ${task.lastRunStatus}${task.lastRunError ? " (" + task.lastRunError + ")" : ""}`);
  });

  sched
    .command("migrate")
    .description(`Move jobs from the pre-0.5 client-side scheduler (${LEGACY_SCHEDULE_PATH}) into T3 Code and remove the launchd ticker. Dry run unless --apply.`)
    .option("--apply", "create the tasks, then uninstall the ticker and rename the legacy file", false)
    .action(async (o: { apply: boolean }) => {
      const g = program.opts<GlobalOpts>();
      const jobs = readLegacyJobs();
      const pending = jobs.filter((j) => j.nextAt);
      const conversions = pending.map(convertLegacyJob);
      const ticker = launchd.isLoaded();
      const ctx = await connect(g, { write: o.apply });
      const shell = await withAuthRetry(ctx, g, api.shell);
      const config = await fetchConfig(ctx.server, ctx.client.token);
      const existing = (await withAuthRetry(ctx, g, (cl) => rpc<{ tasks: ScheduledTask[] }>(cl, "scheduledTasks.list", {}))).tasks;
      const plan: Array<Record<string, unknown>> = [];
      const created: ScheduledTask[] = [];
      for (const c of conversions) {
        if (!c.ok) { plan.push({ job: c.job.id, action: "skip", reason: c.reason, cron: c.job.cron ?? null, nextAt: c.job.nextAt }); continue; }
        try {
          const target = await resolveTarget(ctx, shell, config, { project: c.job.new?.project, thread: c.job.send?.thread, model: c.job.new?.model ?? c.job.send?.model, effort: c.job.new?.effort ?? c.job.send?.effort, env: c.job.new?.env, runtimeMode: c.job.new?.runtimeMode as RuntimeMode | undefined, interactionMode: c.job.new?.interactionMode as InteractionMode | undefined });
          const targetLabel = target.threadId ? `thread ${short(target.threadId)}` : `project ${target.projectId}`;
          // Same target + same schedule already on the server (hand-made in the app, or an earlier migrate run): creating
          // another would fire twice. Skip it; the legacy job is retired with the file either way.
          const dup = [...existing, ...created].find((t) => sameTarget(t, target) && describeSchedule(t.schedule) === describeSchedule(c.schedule));
          if (dup) { plan.push({ job: c.job.id, action: "skip", reason: `already scheduled as task ${dup.id} (${dup.title})`, cron: c.job.cron, schedule: describeSchedule(c.schedule), target: targetLabel, existingTaskId: dup.id }); continue; }
          const input = { commandId: `t3ctl-migrate:${c.job.id}`, title: c.title, prompt: c.prompt, enabled: true, schedule: c.schedule, ...target, createdBy: "user", creationSource: "server" };
          plan.push({ job: c.job.id, action: o.apply ? "create" : "would-create", cron: c.job.cron, schedule: describeSchedule(c.schedule), target: targetLabel, ...(c.note ? { note: c.note } : {}) });
          if (o.apply) created.push((await withAuthRetry(ctx, g, (cl) => rpc<{ task: ScheduledTask }>(cl, "scheduledTasks.upsert", input))).task);
        } catch (e) {
          plan.push({ job: c.job.id, action: "skip", reason: e instanceof Error ? e.message : String(e), cron: c.job.cron ?? null });
        }
      }
      let cleanup: Record<string, unknown> = {};
      if (o.apply) {
        const un = launchd.uninstall();
        const archived = `${LEGACY_SCHEDULE_PATH.replace(/\.json$/, "")}.legacy.json`;
        if (existsSync(LEGACY_SCHEDULE_PATH)) renameSync(LEGACY_SCHEDULE_PATH, archived);
        cleanup = { tickerRemoved: un.removed, legacyFile: existsSync(archived) ? archived : null, log: LEGACY_LOG_PATH };
      }
      const out = { apply: o.apply, legacyJobs: jobs.length, pendingJobs: pending.length, tickerInstalled: ticker, plan, created: created.map((t) => ({ id: t.id, title: t.title, schedule: describeSchedule(t.schedule), nextRunAt: t.nextRunAt })), ...cleanup };
      emit(ctx.format, out, () => [
        `legacy jobs: ${jobs.length} (${pending.length} pending)  ticker: ${ticker ? "installed" : "not installed"}`,
        ...plan.map((p) => `  ${p.job}  ${p.action}  ${p.cron ?? "once"}${p.schedule ? ` → ${p.schedule}` : ""}${p.target ? `  ${p.target}` : ""}${p.reason ? `  (${p.reason})` : ""}${p.note ? `  [${p.note}]` : ""}`),
        o.apply ? `created ${created.length} task(s); ticker ${cleanup.tickerRemoved ? "removed" : "was not installed"}; legacy file → ${cleanup.legacyFile ?? "(none)"}` : "dry run; re-run with --apply to create these tasks and remove the ticker",
      ].join("\n"));
    });

  // The launchd agent of ≤ 0.4 keeps invoking `schedule tick` every minute until `migrate --apply` removes it.
  // Stay quiet and successful so it does not spam the log; `install` points at the replacement.
  sched.command("tick", { hidden: true }).action(() => { process.stderr.write("t3ctl: the client-side scheduler was removed in 0.5; run `t3ctl schedule migrate --apply`\n"); });
  for (const legacy of ["install", "uninstall"]) {
    sched.command(legacy, { hidden: true }).action(() => { throw new CliError("removed_command", `\`schedule ${legacy}\` is gone: T3 Code 0.1+ schedules server-side. Run \`t3ctl schedule migrate\` to move legacy jobs and remove the ticker.`, { command: `schedule ${legacy}` }); });
  }
}

/** A task targets the same place as a resolved target: the same thread, or (thread-less) the same project. */
function sameTarget(t: ScheduledTask, target: { projectId: string; threadId: string | null }): boolean {
  return target.threadId ? t.threadId === target.threadId : (!t.threadId && t.projectId === target.projectId);
}

interface TargetOpts { project?: string; thread?: string; model?: string; effort?: string; env?: string; base?: string; branch?: string; runtimeMode?: RuntimeMode; interactionMode?: InteractionMode }
interface ScheduleOpts { every?: string; at?: string; days?: string; cron?: string; webhook?: boolean }
type AddOpts = TargetOpts & ScheduleOpts & { title?: string; disabled: boolean };
type UpdateOpts = Omit<TargetOpts, "project" | "thread"> & ScheduleOpts & { title?: string };

function scheduleFromFlags(o: ScheduleOpts): Schedule | undefined {
  const picked = [o.every !== undefined, o.at !== undefined, o.cron !== undefined, o.webhook === true].filter(Boolean).length;
  if (picked > 1) throw new CliError("invalid_option", "pass only one of --every, --at, --cron, --webhook", { option: "schedule" });
  if (o.days !== undefined && o.at === undefined) throw new CliError("invalid_option", "--days needs --at HH:MM", { option: "days" });
  if (o.every !== undefined) return intervalSchedule(o.every);
  if (o.at !== undefined) return fixedTimeSchedule(o.at, o.days);
  if (o.cron !== undefined) return cronToSchedule(o.cron);
  if (o.webhook) return { type: "webhook", signature: null };
  return undefined;
}

const effort = (ms: { options?: Array<{ id: string; value: unknown }> }) => { const v = ms.options?.find((x) => x.id === "effort")?.value; return typeof v === "string" ? v : undefined; };

function gitBranch(cwd: string): string | undefined {
  try { const b = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); return b && b !== "HEAD" ? b : undefined; } catch { return undefined; }
}

/** Project / thread / model / modes / workspace strategy for an upsert, validated against the live catalog. */
async function resolveTarget(ctx: Ctx, shell: { projects: ShellProject[]; threads: ShellThread[]; archivedThreads?: ShellThread[] }, config: ServerConfig, o: TargetOpts): Promise<{ projectId: string; threadId: string | null; workspaceStrategy: Record<string, unknown>; modelSelection: ModelSelection; runtimeMode: RuntimeMode; interactionMode: InteractionMode }> {
  const d = applyDefaults({ model: o.model, effort: o.effort, env: o.env, runtimeMode: o.runtimeMode, interactionMode: o.interactionMode });
  if (o.thread) {
    const t = matchThread([...shell.threads, ...(shell.archivedThreads ?? [])], o.thread);
    if (t.archivedAt) throw new CliError("thread_archived", `thread ${short(t.id)} is archived`, { threadId: t.id });
    const project = shell.projects.find((p) => p.id === t.projectId);
    if (!project) throw new CliError("project_not_found", `thread ${short(t.id)} belongs to an unknown project`, { ref: t.projectId });
    // A bound run follows the thread's current provider; the stored selection only matters for new threads.
    const modelSelection = (await resolveTurnModel(ctx, t, { model: d.model, effort: d.effort })) ?? (t.modelSelection as ModelSelection | undefined) ?? (await resolveNewModel(ctx, project, { effort: d.effort }, config)).modelSelection;
    return { projectId: project.id, threadId: t.id, workspaceStrategy: { type: "root" }, modelSelection, runtimeMode: (o.runtimeMode ?? (t.runtimeMode as RuntimeMode | undefined) ?? d.runtimeMode), interactionMode: (o.interactionMode ?? (t.interactionMode as InteractionMode | undefined) ?? d.interactionMode) };
  }
  const project = matchProject(shell.projects, o.project ?? "");
  const { modelSelection, settings } = await resolveNewModel(ctx, project, { model: d.model, effort: d.effort }, config);
  const envMode = envModeOf(d.env, settings, project.defaultThreadEnvMode);
  const branch = gitBranch(project.workspaceRoot);
  const baseRef = o.base ?? branch;
  const workspaceStrategy = envMode === "worktree" && baseRef
    ? { type: "worktree", baseRef, ...(o.branch ? { branch: o.branch } : {}), ...(settings.newWorktreesStartFromOrigin === true ? { startFromOrigin: true } : {}) }
    : { type: "root", ...(branch ? { branch } : {}) };
  return { projectId: project.id, threadId: null, workspaceStrategy, modelSelection, runtimeMode: d.runtimeMode, interactionMode: d.interactionMode };
}

async function findTask(ctx: Ctx, g: GlobalOpts, ref: string): Promise<ScheduledTask> {
  const { tasks } = await withAuthRetry(ctx, g, (c) => rpc<{ tasks: ScheduledTask[] }>(c, "scheduledTasks.list", {}));
  return matchTask(tasks, ref);
}

function legacyState(): { pendingJobs: number; tickerInstalled: boolean; file: string } | undefined {
  const jobs = readLegacyJobs();
  const ticker = launchd.isLoaded();
  if (jobs.length === 0 && !ticker) return undefined;
  return { pendingJobs: jobs.filter((j) => j.nextAt).length, tickerInstalled: ticker, file: LEGACY_SCHEDULE_PATH };
}

export { pickFormat };
