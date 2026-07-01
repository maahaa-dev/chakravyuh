import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The per-run Pi stdout log path: `<logDir>/<slug>-<role>-a<attempt>.log`. Pure — no filesystem
 * access. `logDir` must live outside `project.root` (e.g. `loops/<proj>/logs/`); callers are
 * responsible for that leak guard, this function only formats the path.
 *
 * @example
 * ```ts
 * piLogPath("/loops/p/logs", "fix-add", "maker", 1) // → "/loops/p/logs/fix-add-maker-a1.log"
 * ```
 */
export function piLogPath(logDir: string, slug: string, role: string, attempt: number): string {
  return join(logDir, `${slug}-${role}-a${attempt}.log`);
}

/**
 * Builds a best-effort stdout-chunk sink that appends to the per-run path from {@link piLogPath} —
 * so `tail -f` shows a live agent run. The log dir is created lazily on the first chunk (recursive
 * mkdir): without it, `appendFileSync` throws ENOENT on a fresh `loops/<proj>/logs/` and the tee
 * would be silently inert. Any write failure (missing dir creation, permissions, ...) is swallowed —
 * this sink must never throw into the caller's run path.
 *
 * @example
 * createFileTee("loops/p/logs", "fix-add", "maker", 1) // -> appends to fix-add-maker-a1.log
 */
export function createFileTee(
  logDir: string, slug: string, role: string, attempt: number,
): (chunk: string) => void {
  const logPath = piLogPath(logDir, slug, role, attempt);
  let dirReady = false;
  return (chunk: string): void => {
    try {
      if (!dirReady) { mkdirSync(dirname(logPath), { recursive: true }); dirReady = true; }
      appendFileSync(logPath, chunk);
    } catch { /* best effort */ }
  };
}
