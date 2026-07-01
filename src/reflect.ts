import type { Role, Run, WorkUnit, WorkUnitStatus } from "./domain.js";
import { piLogPath } from "./pi-log.js";

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
