import { discoverServer, type Server } from "./discover.js";
import { ensureToken, pair, READ_SCOPES, OPERATE_SCOPES } from "./auth.js";
import { makeClient, HttpError, type Client } from "./http.js";
import { CliError } from "./errors.js";
import { pickFormat, type Format } from "./output.js";
import { readConfig } from "./config.js";

/** `autoPair` is commander's name for `--no-auto-pair` (false when the flag is given). */
export interface GlobalOpts { origin?: string; format?: string; autoPair?: boolean }

export interface Ctx { server: Server; client: Client; format: Format }

/**
 * Resolve server + token for a command. `write: true` requires orchestration:operate (triggers an
 * automatic re-pair with the wider scope when our stored session is read-only).
 */
export async function connect(opts: GlobalOpts, { write = false } = {}): Promise<Ctx> {
  const server = await discoverServer(opts.origin);
  const need = write ? OPERATE_SCOPES : READ_SCOPES;
  const token = await ensureToken(server, need, { autoPair: opts.autoPair !== false });
  return { server, client: makeClient(server, token), format: pickFormat(opts.format) };
}

/**
 * Run `fn`; if the server answers 401 (token revoked/expired server-side) re-pair once and retry.
 */
export async function withAuthRetry<T>(ctx: Ctx, opts: GlobalOpts, fn: (c: Client) => Promise<T>): Promise<T> {
  try {
    return await fn(ctx.client);
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 401) throw e;
    if (process.env.T3CTL_TOKEN) throw new CliError("auth", "server rejected T3CTL_TOKEN (401); unset it to use the stored session, or mint a new token", { status: 401 });
    if (opts.autoPair === false) throw new CliError("auth", "server rejected the stored token (401); run `t3ctl auth pair` (or drop --no-auto-pair)", { status: 401 });
    process.stderr.write("t3ctl: server rejected stored token (401); re-pairing…\n");
    const cfg = readConfig();
    const res = await pair(ctx.server, { label: cfg.label, operate: (cfg.scopes ?? []).includes("orchestration:operate") });
    ctx.client = makeClient(ctx.server, res.token);
    return fn(ctx.client);
  }
}
