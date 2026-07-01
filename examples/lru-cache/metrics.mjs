/**
 * Per-role run metrics for a Chakravyuh unit — the flow, and what each role cost.
 *
 * Reads the SQLite `runs` table the loop writes and prints, per attempt: which model played each
 * role, its token in/out, stop reason, verdict, and wall-clock. Checker and reviewer share a start
 * time because they run concurrently (Promise.all) — their durations overlap, they don't add up.
 *
 *   node examples/lru-cache/metrics.mjs <config.json> [unit-slug]
 *
 * Dependency-light: uses better-sqlite3 (already a repo dependency) and reads dbPath from the config.
 */
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

const [configPath, slug] = process.argv.slice(2);
if (!configPath) {
  console.error("usage: node metrics.mjs <config.json> [unit-slug]");
  process.exit(2);
}

const cfg = JSON.parse(readFileSync(configPath, "utf8"));
const db = new Database(cfg.dbPath, { readonly: true });

const rows = db.prepare(`
  SELECT r.role, r.attempt, r.model, r.started_at, r.ended_at,
         r.stop_reason, r.tokens_in, r.tokens_out, r.verdict_json, u.slug, u.status
  FROM runs r JOIN work_units u ON u.id = r.work_unit_id
  ${slug ? "WHERE u.slug = ?" : ""}
  ORDER BY r.seq
`).all(...(slug ? [slug] : []));

if (rows.length === 0) {
  console.log("no runs recorded yet.");
  process.exit(0);
}

const secs = (a, b) => ((new Date(b) - new Date(a)) / 1000).toFixed(1) + "s";
const verdict = (j) => {
  if (j == null) return "—";
  try { return JSON.parse(j).pass ? "PASS" : "FAIL"; } catch { return "?"; }
};
const ROLE_ORDER = { maker: 0, checker: 1, reviewer: 2 };

console.log(`\nunit: ${rows[0].slug} — ${rows[0].status}\n`);
console.log("flow:  maker → health gate → (checker ∥ reviewer)   [gate runs before either verifier votes]\n");

const header = ["attempt", "role", "model", "tok in", "tok out", "stop", "verdict", "wall"];
const table = rows
  .slice()
  .sort((a, b) => a.attempt - b.attempt || ROLE_ORDER[a.role] - ROLE_ORDER[b.role])
  .map((r) => [
    `a${r.attempt}`, r.role, r.model,
    String(r.tokens_in), String(r.tokens_out),
    r.stop_reason ?? "—", verdict(r.verdict_json), secs(r.started_at, r.ended_at),
  ]);

const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
const fmt = (row) => row.map((c, i) => c.padEnd(widths[i])).join("  ");
console.log(fmt(header));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const row of table) console.log(fmt(row));

const totIn = rows.reduce((s, r) => s + r.tokens_in, 0);
const totOut = rows.reduce((s, r) => s + r.tokens_out, 0);
console.log(`\ntotals: ${rows.length} role-runs · ${totIn} tok in · ${totOut} tok out · ${totIn + totOut} total`);
db.close();
