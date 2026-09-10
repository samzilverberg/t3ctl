import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { connect, withAuthRetry, type GlobalOpts } from "../context.js";
import { api } from "../http.js";
import { fetchProviders, resolveModel } from "../models.js";
import { emit, pickFormat, renderTable, short } from "../output.js";
import { applyDefaults, createThread, matchProject, matchThread, startTurn } from "../ops.js";
import { threadStatus } from "../wait.js";
import { nowIso } from "../ids.js";
import { acquireLock, describeWhen, evaluate, LOG_PATH, newJobId, parseDuration, parseSchedule, readStore, recordRun, SCHEDULE_PATH, writeStore, type Job, type Run } from "../schedule.js";
import * as launchd from "../launchd.js";

export function registerSchedule(program: Command) {
  const sched = program.command("schedule").description("Start threads (or send follow-ups) later or on a cron; needs `schedule install` once");

  sched
    .command("add <when> <prompt>")
    .description("Schedule a new thread (-p) or a follow-up on an existing thread (--thread). <when> = one-shot (30m, 2h, HH:MM, \"tomorrow 09:00\", ISO) or cron (\"0 9 * * 1-5\", @hourly, @daily, @weekly)")
    .option("-p, --project <ref>", "project for a new thread per occurrence")
    .option("--thread <ref>", "instead of a new thread, send <prompt> to this thread each occurrence")
    .option("-m, --model <ref>", "model slug or alias")
    .option("-e, --effort <level>", "reasoning effort")
    .option("-t, --title <title>", "thread title (new threads only)")
    .option("--env <mode>", "worktree|local (new threads only)")
    .option("--grace <dur>", "skip the occurrence if it would fire later than this after its time (default: 60m, or half the cron interval)")
    .action(async (when: string, promptArg: string, o: { project?: string; thread?: string; model?: string; effort?: string; title?: string; env?: string; grace?: string }) => {
      const g = program.opts<GlobalOpts>();
      if (!o.project === !o.thread) throw new Error("pass exactly one of -p <project> or --thread <ref>");
      const text = promptArg === "-" ? readFileSync(0, "utf8").trim() : promptArg;
      if (!text) throw new Error("empty prompt");
      const s = parseSchedule(when);
      const graceSec = o.grace ? parseDuration(o.grace) : s.defaultGraceSec;

      // Validate targets now so a typo does not surface at 03:00.
      const ctx = await connect(g);
      const shell = await withAuthRetry(ctx, g, api.shell);
      if (o.project) matchProject(shell.projects, o.project);
      if (o.thread) matchThread(shell.threads, o.thread);
      if (o.model) resolveModel(await fetchProviders(ctx.server, ctx.client.token), o.model);
      if (o.project) applyDefaults({ model: o.model, effort: o.effort, env: o.env });

      const job: Job = {
        id: newJobId(), createdAt: nowIso(), cron: s.cron, nextAt: s.nextAt, graceSec, runs: [],
        ...(o.project
          ? { new: { project: o.project, text, model: o.model, effort: o.effort, title: o.title, env: o.env } }
          : { send: { thread: matchThread(shell.threads, o.thread!).id, text, model: o.model, effort: o.effort } }),
      };
      const store = readStore(); store.jobs.push(job); writeStore(store);
      const loaded = launchd.isLoaded();
      emit(ctx.format, { ...job, tickerInstalled: loaded }, () => `scheduled ${job.id}  ${job.cron ? `cron ${job.cron}` : "once"}  next ${job.nextAt}  grace ${graceSec}s${loaded ? "" : "\nwarning: ticker not installed; run `t3ctl schedule install`"}`);
      if (!loaded) process.stderr.write("t3ctl: ticker not installed; nothing will fire until `t3ctl schedule install`\n");
    });

  sched
    .command("list", { isDefault: true })
    .description("List scheduled jobs (pending by default)")
    .option("-a, --all", "include finished one-shots", false)
    .action((o: { all: boolean }) => {
      const g = program.opts<GlobalOpts>();
      const store = readStore();
      const jobs = o.all ? store.jobs : store.jobs.filter((j) => j.nextAt);
      const ticker = launchd.isLoaded();
      emit(pickFormat(g.format), { ticker: ticker ? "installed" : "not installed", file: SCHEDULE_PATH, jobs }, () =>
        `ticker: ${ticker ? "installed" : "NOT installed (run `t3ctl schedule install`)"}\n` +
        renderTable(jobs.map((j) => {
          const last = j.runs.at(-1);
          return {
            id: j.id, when: describeWhen(j), next: j.nextAt ?? "-", grace: `${Math.round(j.graceSec / 60)}m`,
            target: j.new ? `new @${j.new.project}${j.new.model ? ` ${j.new.model}${j.new.effort ? "@" + j.new.effort : ""}` : ""}` : `send ${short(j.send!.thread)}`,
            prompt: (j.new?.text ?? j.send?.text ?? "").split("\n")[0].slice(0, 40),
            last: last ? `${last.status}${last.threadId ? " " + short(last.threadId) : ""}${last.reason ? " (" + last.reason + ")" : ""}` : "",
          };
        }), ["id", "when", "next", "grace", "target", "prompt", "last"]));
    });

  sched
    .command("remove <id>")
    .description("Remove a job")
    .action((id: string) => {
      const store = readStore();
      const i = store.jobs.findIndex((j) => j.id === id);
      if (i < 0) throw new Error(`job not found: ${id}`);
      const [job] = store.jobs.splice(i, 1); writeStore(store);
      emit(pickFormatFor(program), job, () => `removed ${job.id}`);
    });

  sched
    .command("tick")
    .description("Fire due jobs (what the launchd ticker runs every minute)")
    .action(async () => {
      const g = program.opts<GlobalOpts>();
      const release = acquireLock();
      if (!release) { process.stderr.write("t3ctl: another tick holds the lock\n"); return; }
      try {
        const results = await tick(g);
        // One log line per action goes to stderr (see `log`); print JSON only when explicitly asked.
        if (results.length && g.format === "json") emit("json", results);
      } finally { release(); }
    });

  sched.command("install").description("Install the launchd ticker (runs `schedule tick` every minute while you are logged in)").action(() => {
    const r = launchd.install();
    emit(pickFormatFor(program), { ...r, label: launchd.LAUNCHD_LABEL, log: LOG_PATH }, () => `installed ${launchd.LAUNCHD_LABEL}\nplist ${r.plist}\nnode  ${r.node}\nlog   ${LOG_PATH}`);
  });
  sched.command("uninstall").description("Remove the launchd ticker (jobs stay in the file)").action(() => {
    const r = launchd.uninstall();
    emit(pickFormatFor(program), r, () => (r.removed ? "uninstalled" : "was not installed"));
  });
}

interface TickResult { job: string; at: string; status: Run["status"]; threadId?: string; reason?: string }

async function tick(g: GlobalOpts): Promise<TickResult[]> {
  const now = new Date();
  const store = readStore();
  const due = store.jobs.map((job) => ({ job, ev: evaluate(job, now) })).filter((x) => x.ev.due) as Array<{ job: Job; ev: Extract<ReturnType<typeof evaluate>, { due: true }> }>;
  if (due.length === 0) return [];
  const results: TickResult[] = [];
  let ctx: Awaited<ReturnType<typeof connect>> | undefined;
  let shell: Awaited<ReturnType<typeof api.shell>> | undefined;

  for (const { job, ev } of due) {
    // Claim the occurrence before doing anything, so a crash cannot double-fire.
    job.nextAt = ev.nextAt; writeStore(store);
    const base = { at: ev.at, firedAt: nowIso() };
    const finish = (run: Run) => { recordRun(job, run); writeStore(store); results.push({ job: job.id, at: run.at, status: run.status, threadId: run.threadId, reason: run.reason }); log(job, run); };

    if (ev.late) { finish({ ...base, status: "skipped", reason: `late by ${fmtSec((now.getTime() - Date.parse(ev.at)) / 1000)}${ev.missed ? `, ${ev.missed} earlier occurrence(s) missed` : ""}` }); continue; }
    try {
      ctx ??= await connect(g, { write: true });
      shell ??= await withAuthRetry(ctx, g, api.shell);
      // Recurring: never start while the previous run's thread is still busy.
      const prev = job.cron ? [...job.runs].reverse().find((r) => r.status === "fired" && r.threadId) : undefined;
      const watch = prev?.threadId ?? job.send?.thread;
      if (watch) {
        const t = shell.threads.find((x) => x.id === watch);
        const st = t ? threadStatus(t) : undefined;
        if (st && (st === "running" || st.startsWith("needs-"))) { finish({ ...base, status: "skipped", reason: `previous run ${short(watch)} is ${st}` }); continue; }
      }
      if (job.new) {
        const s = await createThread(ctx, g, { ...job.new, title: job.new.title ?? `${job.new.text.split("\n")[0].slice(0, 60)}` });
        finish({ ...base, status: "fired", threadId: s.threadId, sequence: s.sequence });
      } else if (job.send) {
        const t = matchThread(shell.threads, job.send.thread);
        const r = await startTurn(ctx, g, t, job.send);
        finish({ ...base, status: "fired", threadId: t.id, sequence: r.sequence });
      }
    } catch (e) {
      finish({ ...base, status: "failed", reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

function log(job: Job, run: Run) {
  process.stderr.write(`${run.firedAt} job ${job.id} occurrence ${run.at} ${run.status}${run.threadId ? " thread " + run.threadId : ""}${run.reason ? " — " + run.reason : ""}\n`);
}
function fmtSec(s: number): string { return s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`; }

function pickFormatFor(program: Command) { return pickFormat(program.opts<GlobalOpts>().format); }
