/**
 * Renders a backlog as a plain-text listing for `chakravyuh --list`, so callers (humans or scripts)
 * can see what units exist without spawning Pi or touching the store/git. One line per unit,
 * `<slug>\t<title>`; a unit without a title falls back to its slug so every line stays non-empty.
 */
import type { WorkUnit } from "./domain.js";

export function listUnitsText(units: WorkUnit[]): string {
  return units.map((u) => `${u.slug}\t${u.title || u.slug}`).join("\n");
}
