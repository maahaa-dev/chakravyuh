/**
 * Strips a bounded ordering-counter prefix from `text` — `^\d{1,3}-` — but ONLY when stripping it
 * leaves a non-empty remainder; otherwise `text` is returned unchanged. This is the single,
 * precise rule for "is this a counter or part of the slug itself":
 * - 1–3 leading digits immediately followed by a hyphen are a counter (`06-`, `123-`).
 * - A leading digit NOT followed by a hyphen is part of the slug, never stripped — pins the
 *   `3d-rendering` case: it stays `3d-rendering`, never collapses to `rendering`.
 * - A run of 4+ leading digits is outside the bounded counter shape and is left alone.
 * - A prefix that would strip down to nothing (e.g. `123-`) is left alone too, so a slug is
 *   never emptied out.
 *
 * The one place that decides this; both {@link slugFromIssueFilename} (issue filenames) and
 * {@link "./backlog-md.js".parseBacklog} (backlog `## ` headers) route through it so the two
 * intake paths always agree on a logical unit's slug — and therefore its `projectId:slug` id.
 */
export function stripOrderingPrefix(text: string): string {
  const m = text.match(/^\d{1,3}-(.+)$/);
  return m ? m[1] : text;
}

/**
 * Derives the bare slug from an issue-tracker filename, e.g. `<featureDir>/issues/NN-slug.md`.
 *
 * Strips a trailing `.md` extension, then runs the result through {@link stripOrderingPrefix} to
 * remove a leading ordering counter — so `06-sync-status.md` and `sync-status.md` both yield
 * `sync-status`, while `3d-rendering.md` stays `3d-rendering` (no counter shape to strip). This
 * keeps issue-derived slugs aligned with the bare `## <slug>` headers that {@link
 * "./backlog-md.js".parseBacklog} reads from `backlog.md`, since both feed the same SQLite-backed
 * run store.
 */
export function slugFromIssueFilename(name: string): string {
  return stripOrderingPrefix(name.replace(/\.md$/i, ""));
}
