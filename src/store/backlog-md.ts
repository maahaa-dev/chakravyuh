import { newWorkUnit, type WorkUnit } from "../domain.js";
import { stripOrderingPrefix } from "./slug.js";

/**
 * Parses a markdown backlog into ordered work units, one per `## ` section. Each section's first
 * line is the slug, run through {@link stripOrderingPrefix} (the same rule {@link
 * "./issue-md.js".parseIssues} applies to issue filenames) so a `## 06-sync-status` heading and a
 * `06-sync-status.md` issue file for the same logical unit resolve to the same slug + DB id. An
 * optional `title: <…>` line sets the title (defaulting to the slug), and the rest is the spec
 * body. Preamble before the first heading and empty-slug sections are dropped.
 */
export function parseBacklog(md: string, projectId: string): WorkUnit[] {
  const units: WorkUnit[] = [];
  const sections = md.split(/^##\s+/m).slice(1); // drop preamble before first ##
  for (const section of sections) {
    const lines = section.split("\n");
    const slug = stripOrderingPrefix(lines[0].trim());
    if (!slug) continue;
    const body = lines.slice(1);
    let title = slug;
    const specLines: string[] = [];
    for (const line of body) {
      const m = line.match(/^title:\s*(.+)$/i);
      if (m) { title = m[1].trim(); continue; }
      specLines.push(line);
    }
    units.push(newWorkUnit({
      projectId, slug, title, spec: specLines.join("\n").trim(),
    }));
  }
  return units;
}
