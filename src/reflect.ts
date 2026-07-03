import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Role, Run, WorkUnit, WorkUnitStatus } from "./domain.js";
import { piLogPath, createFileTee } from "./pi-log.js";
import { REFLECTOR_BRIEF } from "./briefs.js";
import type { PiSpawnOpts, PiSpawnResult } from "./pi.js";

/**
 * One axis-labelled blocker pulled from a run's verdict, kept alongside the attempt it fired on
 * so a reflection pass can see whether the same complaint recurs across attempts.
 */
export interface RejectReason {
  axis: "Spec" | "Standards";
  attempt: number;
  blocker: string;
}

/**
 * A run's per-run stdout log, paired by role/attempt so a reflection pass can `tail` the exact
 * transcript a reject reason came from.
 */
export interface LogPathEntry {
  runId: string;
  role: Role;
  attempt: number;
  path: string;
}

/**
 * One unit's scored trace digest: how it ended, what it cost, and why it was rejected along the
 * way — everything a reflection pass needs, derived from data already on {@link WorkUnit} and
 * {@link Run}.
 */
export interface UnitReflection {
  unitId: string;
  slug: string;
  outcome: WorkUnitStatus;
  attemptsToApprove: number;
  tokensToApprove: number;
  rejectReasons: RejectReason[];
  logPaths: LogPathEntry[];
}

/** The scored trace digest for a whole store snapshot. */
export interface ReflectionInput {
  units: UnitReflection[];
}

/** Checker judges the Spec axis, reviewer judges Standards — maker runs carry no verdict axis. */
function axisFor(role: Role): "Spec" | "Standards" | undefined {
  if (role === "checker") return "Spec";
  if (role === "reviewer") return "Standards";
  return undefined;
}

/**
 * Pure fold of a {@link WorkStore} snapshot (`units` + `runs`) plus the log directory into a
 * scored trace digest, one entry per unit. No I/O, no spawning — every field is derived from
 * fields already on {@link WorkUnit}/{@link Run}:
 * - `outcome`/`attemptsToApprove` come straight off the unit's terminal status/attempt.
 * - `tokensToApprove` sums `tokensIn + tokensOut` across the unit's runs.
 * - `rejectReasons` flattens each run's `verdict.blockers`, labelled by axis (checker → Spec,
 *   reviewer → Standards) and the attempt they fired on.
 * - `logPaths` pairs each run with its stdout log path via {@link piLogPath} — the same
 *   `<logDir>/<slug>-<role>-a<attempt>.log` convention every other caller uses.
 *
 * Never mutates `units` or `runs`; builds fresh objects throughout.
 */
export function buildReflectionInput(units: WorkUnit[], runs: Run[], logDir: string): ReflectionInput {
  return {
    units: units.map((unit) => {
      const unitRuns = runs.filter((r) => r.workUnitId === unit.id);

      const tokensToApprove = unitRuns.reduce((sum, r) => sum + r.tokensIn + r.tokensOut, 0);

      const rejectReasons: RejectReason[] = unitRuns.flatMap((r) => {
        const axis = axisFor(r.role);
        if (!axis || !r.verdict) return [];
        return r.verdict.blockers.map((blocker) => ({ axis, attempt: r.attempt, blocker }));
      });

      const logPaths: LogPathEntry[] = unitRuns.map((r) => ({
        runId: r.id,
        role: r.role,
        attempt: r.attempt,
        path: piLogPath(logDir, unit.slug, r.role, r.attempt),
      }));

      return {
        unitId: unit.id,
        slug: unit.slug,
        outcome: unit.status,
        attemptsToApprove: unit.attempt,
        tokensToApprove,
        rejectReasons,
        logPaths,
      };
    }),
  };
}

/**
 * Default `--last N` window: how many most-recently-updated units {@link runReflect}'s caller should
 * slice `store.allUnits()` down to before building the digest (units come back ordered newest-first
 * by `updated_at`; see {@link SqliteStore.allUnits}). Small enough to keep the reflector's digest +
 * raw-log reading bounded; tune from real use (see the design doc's open questions).
 */
export const DEFAULT_REFLECT_LAST = 20;

/**
 * Runs the one-shot, read-only reflection pass: spawns exactly ONE reflector role over the given
 * digest via `spawn` (injected — see `runUnit`'s same seam in `loop.ts`), then writes its final text
 * verbatim to `<outputDir>/<ISO-timestamp>.md`, creating `outputDir` if missing. That file is the
 * only thing this function writes — no worktree, no health gate, no git, no commit; the reflector
 * gets read-only tools only (`read,grep,find,ls`) and `cwd` is `process.cwd()` (there is no worktree
 * to confine it to).
 *
 * When `opts.logDir` is set, the spawn's stdout is teed live to
 * `<logDir>/reflect-reviewer-a1.log` via {@link createFileTee}, exactly like every other spawn in
 * the loop — omit it to keep today's behaviour (no tee).
 *
 * Some provider configs occasionally return a 0-byte (or whitespace-only) final `text` on an
 * otherwise successful run. When `opts.fallbackModel` is set and the primary spawn's `text` is
 * empty, this re-spawns exactly once with `model: opts.fallbackModel` (same brief/prompt/tools/tee)
 * and writes whichever result has non-empty text, preferring the primary. If `fallbackModel` is
 * unset, or both attempts come back empty, the primary result is written as-is — this never throws
 * on an empty proposal.
 *
 * Returns the path written, so a caller (e.g. the `reflect` CLI subcommand) can report it.
 */
export async function runReflect(
  spawn: (o: PiSpawnOpts) => Promise<PiSpawnResult>,
  digest: ReflectionInput,
  outputDir: string,
  opts: {
    provider: string; model: string; thinking: string;
    piBinPath?: string; extensions?: string[];
    idleTimeoutMs: number; hardTimeoutMs: number;
    logDir?: string; fallbackModel?: string;
  },
): Promise<string> {
  const tee = opts.logDir != null ? createFileTee(opts.logDir, "reflect", "reviewer", 1) : undefined;

  const spawnOpts = (model: string): PiSpawnOpts => ({
    role: "reviewer", // no dedicated Role value for the reflector (Role stays maker/checker/reviewer);
    // "reviewer" is the closest existing read-only role and only affects session-id shape, not behaviour.
    cwd: process.cwd(),
    provider: opts.provider, model, thinking: opts.thinking,
    tools: "read,grep,find,ls",
    sessionId: `reflect-${Date.now()}`,
    brief: REFLECTOR_BRIEF,
    prompt: `Scored trace digest (JSON):\n${JSON.stringify(digest, null, 2)}`,
    idleTimeoutMs: opts.idleTimeoutMs, hardTimeoutMs: opts.hardTimeoutMs,
    binPath: opts.piBinPath, extensions: opts.extensions,
    tee,
  });

  let res = await spawn(spawnOpts(opts.model));

  if (res.text.trim().length === 0 && opts.fallbackModel != null) {
    const fallbackRes = await spawn(spawnOpts(opts.fallbackModel));
    if (fallbackRes.text.trim().length > 0) res = fallbackRes;
  }

  mkdirSync(outputDir, { recursive: true });
  const path = join(outputDir, `${new Date().toISOString()}.md`);
  writeFileSync(path, res.text);
  return path;
}
