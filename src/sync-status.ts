/**
 * `sync-status` — the explicit, human-run, outside-the-loop step that reflects a verified run's
 * outcome back into the issue tracker. Chakravyuh never writes to the issue-tracker dir during a drain (leak
 * guard), so after a human has verified a drained issue's branch, this is how the by-hand `Status:`
 * flip gets automated. Run only as a `chakravyuh sync-status` subcommand — never from {@link
 * "./loop.js"} or any drain path.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkUnitStatus } from "./domain.js";
import { slugFromIssueFilename } from "./store/slug.js";
import type { WorkStore } from "./store/work-store.js";

/** The single source of truth for what an issue-tracker `Status:` line looks like. */
const STATUS_RE = /^Status:\s*/i;

/**
 * Reads an issue file's current `Status:` value from its raw text, or `null` if it has no `Status:`
 * line. The one place that knows how a status line is shaped — {@link setIssueStatus} and {@link
 * syncStatus} both read through it rather than re-implementing the match.
 */
export function parseIssueStatus(raw: string): string | null {
  const line = raw.split("\n").find((l) => STATUS_RE.test(l));
  return line === undefined ? null : line.replace(STATUS_RE, "").trim();
}

/**
 * Pure mapping from a work unit's latest terminal DB status to the issue-tracker `Status:` value,
 * matching the by-hand convention (no new vocabulary):
 * - `approved` → `ready-for-human` (branch awaits human merge+promote; approved ≠ shipped)
 * - `failed` → `needs-triage` (kick back for re-scoping)
 * - anything else (non-terminal, unknown, or `undefined`) → `null`, meaning leave unchanged.
 */
export function mapDbStatusToIssueStatus(dbStatus: WorkUnitStatus | undefined): string | null {
  if (dbStatus === "approved") return "ready-for-human";
  if (dbStatus === "failed") return "needs-triage";
  return null;
}

/**
 * Rewrites ONLY the file's `Status:` line to `status`, preserving every other byte. Returns `true`
 * if the file was changed, `false` if it has no `Status:` line (left untouched) or the line already
 * reads `status` (idempotent no-op).
 */
export function setIssueStatus(path: string, status: string): boolean {
  const raw = readFileSync(path, "utf8");
  const current = parseIssueStatus(raw);
  if (current === null || current === status) return false;

  const lines = raw.split("\n");
  const idx = lines.findIndex((l) => STATUS_RE.test(l));
  lines[idx] = `Status: ${status}`;
  writeFileSync(path, lines.join("\n"));
  return true;
}

/** One `Status:` line rewrite applied by {@link syncStatus}. */
export interface SyncStatusChange { slug: string; from: string; to: string; }

/** Two or more issue files that resolved to the same slug — none of them were touched. */
export interface SyncStatusCollision { slug: string; files: string[]; }

/** The outcome of one {@link syncStatus} pass. */
export interface SyncStatusResult {
  changes: SyncStatusChange[];
  /** Filenames (under `<featureDir>/issues/`) with no `Status:` line, left untouched. */
  noStatusLine: string[];
  /**
   * Slugs claimed by more than one file in the issues dir (e.g. `06-foo.md` + `07-foo.md`). Every
   * file involved is left untouched rather than silently conflated into one DB row — fix the
   * filenames (or headings) so each slug is unique, then re-run.
   */
  collisions: SyncStatusCollision[];
}

/**
 * Reads every issue under `<featureDir>/issues/`, looks up its latest stored work-unit status in
 * `store` (id `<projectId>:<slug>`, slug from {@link slugFromIssueFilename}), and applies {@link
 * mapDbStatusToIssueStatus} via {@link setIssueStatus}. Idempotent — a second call against the same
 * state makes no changes. Files with no `Status:` line are reported, not modified. Files whose
 * slug collides with another file's are reported under `collisions` and left untouched (see
 * {@link SyncStatusCollision}) instead of being silently conflated into the same DB row. If
 * `<featureDir>/issues` doesn't exist, returns an empty result.
 */
export function syncStatus(featureDir: string, store: WorkStore, projectId: string): SyncStatusResult {
  const issuesDir = join(featureDir, "issues");
  let files: string[];
  try {
    files = readdirSync(issuesDir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return { changes: [], noStatusLine: [], collisions: [] };
  }

  const filesBySlug = new Map<string, string[]>();
  for (const file of files) {
    const slug = slugFromIssueFilename(file);
    const group = filesBySlug.get(slug);
    if (group) group.push(file); else filesBySlug.set(slug, [file]);
  }

  const collisions: SyncStatusCollision[] = [];
  const collidedFiles = new Set<string>();
  for (const [slug, group] of filesBySlug) {
    if (group.length > 1) {
      collisions.push({ slug, files: group });
      for (const f of group) collidedFiles.add(f);
    }
  }

  const changes: SyncStatusChange[] = [];
  const noStatusLine: string[] = [];

  for (const file of files) {
    if (collidedFiles.has(file)) continue;
    const slug = slugFromIssueFilename(file);
    const path = join(issuesDir, file);

    const from = parseIssueStatus(readFileSync(path, "utf8"));
    if (from === null) { noStatusLine.push(file); continue; }

    const unit = store.getWorkUnit(`${projectId}:${slug}`);
    const to = mapDbStatusToIssueStatus(unit?.status);
    if (to === null || to === from) continue;

    if (setIssueStatus(path, to)) {
      changes.push({ slug, from, to });
    }
  }

  return { changes, noStatusLine, collisions };
}
