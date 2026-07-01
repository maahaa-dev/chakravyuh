import { spawnSync } from "node:child_process";
import type { GateResult } from "./domain.js";

/** Keep only the tail of captured gate output — enough to debug a failure, bounded for the DB/prompt. */
const MAX_OUTPUT = 4000;

/**
 * Runs the project's health command in `cwd` as the authoritative pass/fail gate. A null exit status
 * (the process was signalled, timed out, or never started) is treated as failure (exit code 1).
 * Combined stdout+stderr is captured (tail only) so a failed gate is debuggable. When `timeoutMs` is
 * given, a command that overruns it is killed rather than hanging the loop forever — `pi.ts` has its
 * own timeouts; without this the gate had none.
 */
export function runHealth(command: string, cwd: string, timeoutMs?: number): GateResult {
  const start = Date.now();
  const res = spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout: timeoutMs });
  const combined = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const output = combined.length > MAX_OUTPUT ? combined.slice(-MAX_OUTPUT) : combined;
  return { command, exitCode: res.status ?? 1, durationMs: Date.now() - start, output: output || undefined };
}
