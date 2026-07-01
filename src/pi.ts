import { spawn } from "node:child_process";
import type { Role, Run } from "./domain.js";
import { parsePiStream } from "./pi-parse.js";
import { wrapWithSeatbelt } from "./sandbox.js";

/**
 * Default path to the forked Pi CLI the driver spawns, relative to this module.
 */
export const DEFAULT_PI_BIN = "../pi/packages/coding-agent/dist/cli.js";

/**
 * Pi extensions (`-e`) loaded into every spawn when a config doesn't set its own. Empty by default —
 * configure Pi with your model provider's credentials per Pi's own documentation, and add any
 * extension paths you need via `config.extensions`.
 */
export const DEFAULT_EXTENSIONS: string[] = [];

/**
 * Everything needed to spawn one Pi role-run. The required fields describe the agent turn; the
 * optional tail (`binPath` … `extensions`) lets tests substitute the binary, runner, env, and
 * confinement.
 */
export interface PiSpawnOpts {
  role: Role; cwd: string; provider: string; model: string; thinking: string;
  tools: string; sessionId: string; brief: string; prompt: string;
  idleTimeoutMs: number; hardTimeoutMs: number;
  binPath?: string; runner?: string; env?: Record<string, string>;
  sandbox?: boolean; extensions?: string[];
  /**
   * Best-effort sink for each raw stdout chunk, called before parsing — e.g. a file tee (see
   * `createFileTee` in `pi-log.ts`). Omit to keep today's behaviour (no tee). A throwing `tee`
   * is swallowed and never breaks the run or changes parse/timeout behaviour; this is purely an
   * observation seam, `spawnPi` has no opinion on where chunks go.
   */
  tee?: (chunk: string) => void;
}

/**
 * Normalizes an id into a valid Pi `--session-id`: maps any char outside `[A-Za-z0-9._-]` to `-`,
 * then trims to an alphanumeric boundary. Pi ≥0.80.2 rejects a leading/trailing `.`/`_`/`-` and the
 * `:` joiner in `${projectId}:${slug}-${role}-${attempt}`, exiting 1 with zero output (the maker
 * never runs) — so the trim is load-bearing. Idempotent; an empty result falls back to `"session"`.
 *
 * @example
 * ```ts
 * sanitizeSessionId("manja:day17-maker-1") // → "manja-day17-maker-1"
 * ```
 */
export function sanitizeSessionId(id: string): string {
  const mapped = id.replace(/[^A-Za-z0-9._-]/g, "-");
  const trimmed = mapped.replace(/^[._-]+/, "").replace(/[._-]+$/, "");
  return trimmed.length > 0 ? trimmed : "session";
}

/**
 * Assembles Pi's argv for `--mode json --print`. Pure and deterministic — exported so the arg shape
 * is unit-testable without spawning. Each configured extension is loaded via its own `-e` flag.
 */
export function buildPiArgs(o: PiSpawnOpts, bin: string): string[] {
  const extArgs = (o.extensions ?? []).flatMap((e) => ["-e", e]);
  return [
    bin, "--mode", "json",
    "-a",                               // auto-approve: trust project files for headless tool execution
    "--print",                          // non-interactive: process prompt and exit (no stdin wait)
    "--session-id", sanitizeSessionId(o.sessionId), "--no-context-files",
    ...extArgs,
    "--provider", o.provider, "--model", o.model, "--thinking", o.thinking,
    "--tools", o.tools, "--append-system-prompt", o.brief,
    o.prompt,
  ];
}

/**
 * The folded outcome of a Pi spawn — session id, normalized stop reason, summed token usage, the
 * assistant text, and the raw process exit reason behind it.
 */
export interface PiSpawnResult {
  sessionId?: string; stopReason?: Run["stopReason"];
  tokensIn: number; tokensOut: number; text: string; exitReason: string;
}

/**
 * Spawns one Pi role-run as a child process (stdin closed, optionally Seatbelt-wrapped), line-buffers
 * its stdout, and resolves the folded {@link PiSpawnResult}. An idle timeout resets on any stdout or
 * stderr; a hard timeout is absolute; both SIGTERM the child. The promise never rejects — every
 * failure (exit code, timeout, spawn error) surfaces as the result's `stopReason` / `exitReason`.
 *
 * When `o.tee` is given, each raw stdout chunk is also passed to it, best-effort, before parsing —
 * so a caller can stream the agent live (e.g. to a log file). A throwing `tee` never affects
 * parsing/timeouts and never breaks the run.
 */
export function spawnPi(o: PiSpawnOpts): Promise<PiSpawnResult> {
  const bin = o.binPath ?? DEFAULT_PI_BIN;
  const runner = o.runner ?? "node";
  const args = buildPiArgs(o, bin);
  const baseArgv = [runner, ...args];
  const finalArgv = wrapWithSeatbelt(baseArgv, { worktree: o.cwd, enabled: o.sandbox ?? false });
  return new Promise((resolve) => {
    const child = spawn(finalArgv[0], finalArgv.slice(1), {
      cwd: o.cwd, env: { ...process.env, ...o.env },
      stdio: ["ignore", "pipe", "pipe"], // close stdin so Pi doesn't block waiting for input
    });
    const lines: string[] = [];
    let buf = "";
    let exitReason = "";
    // Best-effort tee (Article 3: the gate is boss, not logs) — a throwing sink must never surface
    // into the run's result.
    const tee = (chunk: string): void => {
      try { o.tee?.(chunk); } catch { /* best effort */ }
    };

    const finish = (reason: string) => {
      if (exitReason) return;
      exitReason = reason;
      const parsed = parsePiStream(lines);
      const timedOut = reason.includes("timeout");
      resolve({
        ...parsed,
        stopReason: timedOut ? "timeout" : parsed.stopReason,
        exitReason: reason,
      });
    };

    const hard = setTimeout(() => { child.kill("SIGTERM"); finish("hard-timeout"); }, o.hardTimeoutMs);
    let idle = setTimeout(() => { child.kill("SIGTERM"); finish("idle-timeout"); }, o.idleTimeoutMs);
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => { child.kill("SIGTERM"); finish("idle-timeout"); }, o.idleTimeoutMs);
    };

    child.stdout.on("data", (c) => {
      resetIdle();
      const str = c.toString();
      tee(str);
      buf += str;
      for (let nl; (nl = buf.indexOf("\n")) >= 0; ) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on("data", () => resetIdle());
    child.on("exit", (code) => { clearTimeout(hard); clearTimeout(idle); finish(`exit:${code ?? "null"}`); });
    child.on("error", () => { clearTimeout(hard); clearTimeout(idle); finish("spawn-error"); });
  });
}
