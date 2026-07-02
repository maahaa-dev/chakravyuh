/**
 * Renders a plain-text status report for `chakravyuh <config> status`, so operators can see the
 * loop's live state without hand-querying SQLite. Pure — takes the units and runs already loaded
 * from the store and does no I/O itself.
 */
import type { Run, WorkUnit } from "./domain.js";

const TALLY_STATUSES: Array<WorkUnit["status"]> = [
  "pending", "building", "checking", "reviewing", "approved", "blocked", "failed", "done",
];

/**
 * One line per unit (`<slug>: <status> (a<attempt>)`), then an `active:` line naming the most
 * recent run's role and stop reason (omitted when there are no runs at all), then a tally line
 * counting units per status, in the fixed order in {@link TALLY_STATUSES} (a status with zero
 * units is omitted from the tally), then — when `pendingReflections` is greater than zero — a
 * final `reflections: N pending review` line (omitted entirely when it is zero). Reflection
 * proposals are never {@link WorkUnit}s (design doc, decision 3), so this count is the caller's
 * responsibility: this function stays pure and does no directory I/O itself — the CLI reads the
 * `reflections/` dir and passes the count in.
 */
export function renderStatus(units: WorkUnit[], runs: Run[], pendingReflections: number): string {
  const lines: string[] = [];

  for (const u of units) {
    lines.push(`${u.slug}: ${u.status} (a${u.attempt})`);
  }

  if (runs.length > 0) {
    const latest = [...runs].sort(
      (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
    )[runs.length - 1];
    lines.push(`active: ${latest.role} ${latest.stopReason ?? "?"}`);
  }

  const counts = new Map<WorkUnit["status"], number>();
  for (const u of units) {
    counts.set(u.status, (counts.get(u.status) ?? 0) + 1);
  }
  const tally = TALLY_STATUSES
    .filter((s) => (counts.get(s) ?? 0) > 0)
    .map((s) => `${counts.get(s)} ${s}`)
    .join(", ");
  lines.push(tally);

  if (pendingReflections > 0) {
    lines.push(`reflections: ${pendingReflections} pending review`);
  }

  return lines.join("\n");
}
