/**
 * An error the caller is expected to act on. The top-level handler prints `message` to stderr as usual and, in
 * JSON mode (`-f json`, non-TTY, `T3CTL_AGENT=1`), also `{"error": {code, message, ...details}}` to stdout.
 */
export class CliError extends Error {
  constructor(public code: string, message: string, public details: Record<string, unknown> = {}, public exitCode = 1) {
    super(message);
  }
}
