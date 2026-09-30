import { InvalidArgumentError } from "commander";

/** Commander parser for counts and seconds: rejects "abc", "-1", "1.5" as a usage error instead of NaN. */
export function intArg(v: string): number {
  if (!/^\d+$/.test(v.trim())) throw new InvalidArgumentError("expected a whole number");
  return Number(v);
}
