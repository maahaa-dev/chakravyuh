import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { newWorkUnit, type WorkUnit } from "../domain.js";
import { slugFromIssueFilename } from "./slug.js";

/** Issue files are only drained once they're explicitly marked ready by a human/triage step. */
const READY_STATUS = "ready-for-agent";

/**
 * Parses `<featureDir>/issues/NN-slug.md` files into work units, read-only — a second intake
 * alongside {@link parseBacklog} so Chakravyuh can drain a one-file-per-issue tracker instead
 * of (or in addition to) a single `backlog.md`. Run status itself still lives in SQLite; this only
 * produces the pending-shaped units the store would otherwise get from the backlog parser.
 *
 * Only files whose `Status:` line is exactly `ready-for-agent` are returned. A missing or
 * unparsable `Status:` line is treated as not-ready and the file is skipped (fail-closed) — never
 * thrown. If `<featureDir>/issues` doesn't exist, returns an empty list.
 */
export function parseIssues(featureDir: string, projectId = "issues"): WorkUnit[] {
  const issuesDir = join(featureDir, "issues");
  let files: string[];
  try {
    files = readdirSync(issuesDir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }

  const units: WorkUnit[] = [];
  for (const file of files) {
    let unit: WorkUnit | null;
    try {
      const raw = readFileSync(join(issuesDir, file), "utf8");
      unit = parseIssueFile(raw, file, projectId);
    } catch {
      unit = null;
    }
    if (unit) units.push(unit);
  }
  return units;
}

/**
 * Parses one issue file's text into a {@link WorkUnit}, or `null` if it's not ready-for-agent
 * (missing/invalid `Status:` line, or any other status). Exported for direct unit testing.
 */
export function parseIssueFile(raw: string, filename: string, projectId: string): WorkUnit | null {
  const lines = raw.split("\n");

  const statusLine = lines.find((l) => /^Status:\s*/i.test(l));
  if (!statusLine) return null;
  const status = statusLine.replace(/^Status:\s*/i, "").trim();
  if (status !== READY_STATUS) return null;

  const slug = slugFromIssueFilename(filename);

  const titleIdx = lines.findIndex((l) => /^#\s+/.test(l));
  const title = titleIdx >= 0 ? lines[titleIdx].replace(/^#\s+/, "").trim() : slug;

  const bodyLines = titleIdx >= 0 ? lines.slice(titleIdx + 1) : lines.filter((l) => l !== statusLine);
  const spec = bodyLines.join("\n").trim();

  return newWorkUnit({ projectId, slug, title, spec });
}
