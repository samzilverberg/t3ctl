import { randomBytes, randomUUID } from "node:crypto";
export const uuid = () => randomUUID();
export const nowIso = () => new Date().toISOString();
/** Mirrors the desktop's temporary worktree branch naming (`t3code/<hex>`). */
export const tempBranchName = () => `t3code/${randomBytes(4).toString("hex")}`;
