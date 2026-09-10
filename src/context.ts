import { discoverServer, type Server } from "./discover.js";
import { loadToken } from "./auth.js";
import { makeClient, type Client } from "./http.js";
import { pickFormat, type Format } from "./output.js";

export interface GlobalOpts { origin?: string; format?: string }

export async function connect(opts: GlobalOpts): Promise<{ server: Server; client: Client; format: Format }> {
  const server = await discoverServer(opts.origin);
  const token = loadToken(server);
  return { server, client: makeClient(server, token), format: pickFormat(opts.format) };
}
