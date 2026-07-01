/**
 * Pure helpers for `chakravyuh <config> --all`, which drains every non-terminal unit in a backlog
 * through the existing single-unit path instead of stopping after one. No I/O here — the CLI owns
 * spawning, looping, and printing.
 */
import type { WorkUnit, WorkUnitStatus } from "./domain.js";

/**
 * Filters a backlog down to the units `--all` should still run: anything not already
 * `approved`/`failed` (the only terminal statuses for draining). Order is preserved, so an
 * already-drained queue (every unit terminal) yields `[]` — idempotent re-runs are a no-op.
 */
export function unitsToDrain(units: WorkUnit[]): WorkUnit[] {
  return units.filter((u) => u.status !== "approved" && u.status !== "failed");
}

/**
 * Renders the end-of-drain report for `--all`: one `<slug>: <status>` line per unit run, followed
 * by a blank line and an `N approved, M failed` tally (statuses other than `approved`/`failed`
 * count toward neither).
 */
export function drainSummary(results: Array<{ slug: string; status: WorkUnitStatus }>): string {
  const lines = results.map((r) => `${r.slug}: ${r.status}`);
  const approved = results.filter((r) => r.status === "approved").length;
  const failed = results.filter((r) => r.status === "failed").length;
  return `${lines.join("\n")}\n\n${approved} approved, ${failed} failed`;
}
