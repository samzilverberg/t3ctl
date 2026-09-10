import type { Command } from "commander";
import { connect, type GlobalOpts } from "../context.js";
import { api } from "../http.js";
import { emit, renderTable, short } from "../output.js";

export function registerProjects(program: Command) {
  const projects = program.command("projects").alias("project").description("Read projects");

  projects
    .command("list", { isDefault: true })
    .description("List projects with thread counts")
    .action(async () => {
      const { client, format } = await connect(program.opts<GlobalOpts>());
      const shell = await api.shell(client);
      const counts = new Map<string, number>();
      for (const t of shell.threads) counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1);
      const rows = shell.projects.map((p) => ({ ...p, threadCount: counts.get(p.id) ?? 0 }));
      emit(format, rows, () =>
        renderTable(rows.map((p) => ({ id: short(p.id), title: p.title, threads: p.threadCount, workspaceRoot: p.workspaceRoot })), ["id", "title", "threads", "workspaceRoot"]));
    });

  projects
    .command("show <idOrTitle>")
    .description("Show one project (full JSON)")
    .action(async (ref: string) => {
      const { client, format } = await connect(program.opts<GlobalOpts>());
      const shell = await api.shell(client);
      const p = shell.projects.find((x) => x.id === ref || x.id.startsWith(ref) || x.title === ref);
      if (!p) throw new Error(`project not found: ${ref}`);
      emit(format, p, () => JSON.stringify(p, null, 2));
    });
}
