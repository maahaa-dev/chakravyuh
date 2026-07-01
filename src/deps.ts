/**
 * Pure dependency-ordering logic for `--all`: parses a `Blocked by: <slug>, <slug>` (or
 * `deps: [<slug>, <slug>]`) line out of a unit's spec, topologically orders a backlog so a
 * dependency always runs before its dependents, and gives the `--all` loop a way to tell whether
 * a unit should be skipped as `blocked` because a dependency it names ended `failed` (or was
 * itself skipped as `blocked`) — transitively, so nothing runs on top of a broken base. No I/O
 * here — the CLI owns running units and persisting status.
 */
import type { WorkUnit, WorkUnitStatus } from "./domain.js";

const BLOCKED_BY_RE = /^\s*Blocked by:\s*(.+)$/im;
const DEPS_RE = /^\s*deps:\s*(.+)$/im;

/**
 * Extracts the declared dependency slugs from a unit's spec text. Accepts a `Blocked by: a, b`
 * line or a `deps: [a, b]` / `deps: a, b` line (first one found wins, checked in that order);
 * surrounding `[`/`]`, whitespace, and empty entries (e.g. a trailing comma) are dropped. Returns
 * `[]` when neither line is present.
 */
export function parseDeps(spec: string): string[] {
  const m = spec.match(BLOCKED_BY_RE) ?? spec.match(DEPS_RE);
  if (!m) return [];
  return m[1]
    .replace(/[[\]]/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Thrown by {@link drainOrder} on a dependency cycle — a stable, named error instead of a stack
 * overflow or an infinite loop.
 */
export class DrainOrderError extends Error {}

/**
 * Topologically sorts `units` so a unit whose spec declares `Blocked by: <slug>` (see {@link
 * parseDeps}) always comes after every slug it names. A named dependency that isn't in `units`
 * is ignored (it isn't part of this backlog, so it imposes no ordering here). Units with no
 * ordering constraint between them keep their relative input-order (a stable topo sort, via DFS
 * post-order over the input in-order). Throws a {@link DrainOrderError} on a dependency cycle
 * rather than hanging.
 */
export function drainOrder(units: WorkUnit[]): WorkUnit[] {
  const bySlug = new Map(units.map((u) => [u.slug, u]));
  const depsOf = new Map(
    units.map((u) => [u.slug, parseDeps(u.spec).filter((d) => bySlug.has(d))]),
  );

  const result: WorkUnit[] = [];
  const done = new Set<string>();
  const onStack = new Set<string>();

  function visit(slug: string): void {
    if (done.has(slug)) return;
    if (onStack.has(slug)) {
      throw new DrainOrderError(`dependency cycle detected: involves "${slug}"`);
    }
    onStack.add(slug);
    for (const dep of depsOf.get(slug) ?? []) visit(dep);
    onStack.delete(slug);
    done.add(slug);
    result.push(bySlug.get(slug)!);
  }

  for (const u of units) visit(u.slug);
  return result;
}

/**
 * Tells the `--all` loop whether `unit` should be skipped with status `blocked` instead of run:
 * true when any slug in its `Blocked by`/`deps` line (see {@link parseDeps}) maps, in `statuses`,
 * to `failed` or `blocked`. `statuses` is the slug -> outcome map the loop builds up as it works
 * through {@link drainOrder}'s sequence, recording `blocked` for each skipped unit before moving
 * on — so a unit two levels below a failure is blocked transitively, not just its direct
 * dependents. A dependency with no entry yet (not yet run, or not in this backlog) does not block.
 */
export function isBlockedByFailedDep(unit: WorkUnit, statuses: Map<string, WorkUnitStatus>): boolean {
  return parseDeps(unit.spec).some((dep) => {
    const s = statuses.get(dep);
    return s === "failed" || s === "blocked";
  });
}
