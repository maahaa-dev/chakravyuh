/**
 * Pure scheduling logic for `chakravyuh --all`'s parallel drain: given the dependency-ordered
 * backlog (see {@link drainOrder} in `deps.ts`), which units have already settled, and which are
 * currently running, decides which unsettled units may start this tick and which must be marked
 * `blocked` because a dependency failed or was itself blocked. No I/O, no Pi, no concept of
 * "levels" — this is a rolling scheduler: on every tick it re-classifies whatever is left.
 *
 * The driver (`cli.ts`) owns everything stateful: it applies `block` to its status map, spawns
 * each `start` unit, and calls {@link scheduleStep} again once something settles. `cap: 1` behaves
 * identically to the old sequential `for` loop — this file's tests pin that down.
 */
import type { WorkUnit, WorkUnitStatus } from "./domain.js";
import { parseDeps, isBlockedByFailedDep } from "./deps.js";

/**
 * One tick's decision: `start` is the ordered subset of unsettled units to spawn now (bounded by
 * `cap`); `block` is the ordered subset to mark `blocked` instead, because a dependency ended
 * `failed`/`blocked` (transitively — the growing local view of statuses used while walking
 * `ordered` sees blocks recorded earlier in this same tick, so a unit two levels below a failure
 * blocks in one tick rather than needing one tick per level).
 */
export interface ScheduleStep {
  start: WorkUnit[];
  block: WorkUnit[];
}

/**
 * True when every dependency `unit` declares (see {@link parseDeps}) has settled `approved` or
 * `done` in `statuses` — the runnable arm's predicate. A dependency with no entry yet (not run,
 * not in this backlog) is NOT satisfied, so the unit waits rather than starting early.
 */
function depsSatisfied(unit: WorkUnit, statuses: Map<string, WorkUnitStatus>): boolean {
  return parseDeps(unit.spec).every((dep) => {
    const s = statuses.get(dep);
    return s === "approved" || s === "done";
  });
}

/**
 * Classifies every UNSETTLED unit in `ordered` (not already a key in `statuses`, not in
 * `inFlight`) into `start` or `block` for this tick, then caps `start` at the number of free
 * slots (`cap - inFlight.size`), preserving `ordered`'s order for determinism.
 *
 * Per unit, walking `ordered` in order:
 * - a dep that is `failed`/`blocked` (in the local, tick-growing view) -> BLOCK.
 * - every dep `approved`/`done` -> RUNNABLE (subject to the cap).
 * - otherwise (a dep still pending/building/checking/reviewing, or currently in flight, or not
 *   yet classified) -> WAITING: skipped this tick, absent from both `start` and `block`.
 *
 * `statuses` and `inFlight` are read-only here; the driver applies `block` to its own map after
 * this returns.
 */
export function scheduleStep(
  ordered: WorkUnit[],
  statuses: Map<string, WorkUnitStatus>,
  inFlight: Set<string>,
  cap: number,
): ScheduleStep {
  // A local copy so a block recorded earlier in this same tick is visible to later units walked
  // in `ordered` order — transitive blocking within one tick, not one tick per level.
  const local = new Map(statuses);
  const block: WorkUnit[] = [];
  const runnable: WorkUnit[] = [];

  for (const unit of ordered) {
    if (statuses.has(unit.slug) || inFlight.has(unit.slug)) continue; // already settled or running

    if (isBlockedByFailedDep(unit, local)) {
      local.set(unit.slug, "blocked");
      block.push(unit);
      continue;
    }

    if (depsSatisfied(unit, local)) {
      runnable.push(unit);
    }
    // else: waiting on a dep that's still pending/building/checking/reviewing/in-flight — skip.
  }

  const slotsFree = Math.max(0, cap - inFlight.size);
  const start = runnable.slice(0, slotsFree);
  return { start, block };
}
