import type { Run, Verdict, WorkUnit } from "../domain.js";

/**
 * Renders one work unit's human-facing **Brief** block for `current.md` — decision-ready, not a log
 * to reconstruct. Shows the final status and attempt count; for an approved/done unit, the branch
 * (and the commit subject actually landed on it) to review as the asset link, plus a one-line "what
 * changed"; for a blocked/failed unit, the blocking verdict's summary and blockers. Deliberately
 * omits the per-role-run dump — that detail stays in SQLite `runs` for forensics; this is the view
 * on top of it, never a replacement.
 */
export function briefFor(unit: WorkUnit, runs: Run[]): string {
  const lines = [`## ${unit.slug} — ${unit.status} (attempt ${unit.attempt}/${unit.maxAttempts})`];
  const commitSubject = `feat(${unit.slug}): ${unit.title}`;

  if (unit.status === "approved" || unit.status === "done") {
    lines.push(`- Branch: \`chakravyuh/${unit.slug}\` — review commit "${commitSubject}"`);
    lines.push(`- What changed: ${lastVerdictSummary(runs) ?? commitSubject}`);
  } else if (unit.status === "blocked" || unit.status === "failed") {
    const verdict = lastFailingVerdict(runs);
    lines.push(`- Blocked: ${verdict?.summary ?? "no verdict recorded"}`);
    for (const blocker of verdict?.blockers ?? []) lines.push(`  - ${blocker}`);
  } else {
    lines.push(`- In progress (${unit.status})`);
  }
  return lines.join("\n");
}

/** The most recent verdict's summary, newest run last — the reviewer's if one ran, else the checker's. */
function lastVerdictSummary(runs: Run[]): string | undefined {
  return findLast(runs, (r) => r.verdict !== undefined)?.verdict?.summary;
}

/** The most recent verdict that failed — the one blocking the unit. */
function lastFailingVerdict(runs: Run[]): Verdict | undefined {
  return findLast(runs, (r) => r.verdict?.pass === false)?.verdict;
}

function findLast<T>(arr: T[], pred: (item: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return arr[i];
  return undefined;
}
