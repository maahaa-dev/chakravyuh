import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import type { Run, WorkUnit, WorkUnitStatus } from "../domain.js";
import type { WorkStore } from "./work-store.js";
import { briefFor } from "./brief.js";

/**
 * The {@link WorkStore} backed by a WAL-mode SQLite database — two tables, `work_units` and `runs`.
 * Run records are append-only and ordered by a monotonic global `seq`.
 */
export class SqliteStore implements WorkStore {
  private db: Database.Database;

  /**
   * Opens (creating if absent) the database at `dbPath`, switches it to WAL mode, and ensures the
   * `work_units` and `runs` schema exists.
   */
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_units (
        id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, title TEXT, spec TEXT,
        status TEXT, attempt INTEGER, max_attempts INTEGER,
        created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, work_unit_id TEXT, role TEXT, attempt INTEGER,
        provider TEXT, model TEXT, thinking TEXT, session_id TEXT,
        started_at TEXT, ended_at TEXT, stop_reason TEXT,
        tokens_in INTEGER, tokens_out INTEGER, verdict_json TEXT, exit_reason TEXT,
        seq INTEGER);
      CREATE TABLE IF NOT EXISTS drain_lock (
        name TEXT PRIMARY KEY, holder TEXT, host TEXT, heartbeat INTEGER);
    `);
    this.db.prepare(
      `INSERT OR IGNORE INTO drain_lock (name, holder, host, heartbeat) VALUES ('drain', NULL, NULL, NULL)`,
    ).run();
  }

  upsertWorkUnit(u: WorkUnit): void {
    this.db.prepare(`
      INSERT INTO work_units (id,project_id,slug,title,spec,status,attempt,max_attempts,created_at,updated_at)
      VALUES (@id,@projectId,@slug,@title,@spec,@status,@attempt,@maxAttempts,@createdAt,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        status=@status, attempt=@attempt, updated_at=@updatedAt`).run(u);
  }

  getWorkUnit(id: string): WorkUnit | null {
    const r: any = this.db.prepare("SELECT * FROM work_units WHERE id=?").get(id);
    if (!r) return null;
    return {
      id: r.id, projectId: r.project_id, slug: r.slug, title: r.title, spec: r.spec,
      status: r.status, attempt: r.attempt, maxAttempts: r.max_attempts,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  allUnits(): WorkUnit[] {
    const rows: any[] = this.db.prepare("SELECT * FROM work_units ORDER BY updated_at DESC").all();
    return rows.map((r) => ({
      id: r.id, projectId: r.project_id, slug: r.slug, title: r.title, spec: r.spec,
      status: r.status, attempt: r.attempt, maxAttempts: r.max_attempts,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }

  setStatus(id: string, status: WorkUnitStatus, attempt: number): void {
    this.db.prepare("UPDATE work_units SET status=?, attempt=?, updated_at=? WHERE id=?")
      .run(status, attempt, new Date().toISOString(), id);
  }

  saveRun(run: Run): void {
    const seq = (this.db.prepare("SELECT COUNT(*) c FROM runs").get() as any).c;
    this.db.prepare(`
      INSERT INTO runs (id,work_unit_id,role,attempt,provider,model,thinking,session_id,
        started_at,ended_at,stop_reason,tokens_in,tokens_out,verdict_json,exit_reason,seq)
      VALUES (@id,@workUnitId,@role,@attempt,@provider,@model,@thinking,@sessionId,
        @startedAt,@endedAt,@stopReason,@tokensIn,@tokensOut,@verdictJson,@exitReason,@seq)`).run({
      ...run,
      sessionId: run.sessionId ?? null, endedAt: run.endedAt ?? null,
      stopReason: run.stopReason ?? null, exitReason: run.exitReason ?? null,
      verdictJson: run.verdict ? JSON.stringify(run.verdict) : null, seq,
    });
  }

  runsForUnit(workUnitId: string): Run[] {
    const rows: any[] = this.db.prepare("SELECT * FROM runs WHERE work_unit_id=? ORDER BY seq").all(workUnitId);
    return rows.map((r) => ({
      id: r.id, workUnitId: r.work_unit_id, role: r.role, attempt: r.attempt,
      provider: r.provider, model: r.model, thinking: r.thinking, sessionId: r.session_id ?? undefined,
      startedAt: r.started_at, endedAt: r.ended_at ?? undefined, stopReason: r.stop_reason ?? undefined,
      tokensIn: r.tokens_in, tokensOut: r.tokens_out,
      verdict: r.verdict_json ? JSON.parse(r.verdict_json) : undefined,
      exitReason: r.exit_reason ?? undefined,
    }));
  }

  allRuns(): Run[] {
    const rows: any[] = this.db.prepare("SELECT * FROM runs ORDER BY seq").all();
    return rows.map((r) => ({
      id: r.id, workUnitId: r.work_unit_id, role: r.role, attempt: r.attempt,
      provider: r.provider, model: r.model, thinking: r.thinking, sessionId: r.session_id ?? undefined,
      startedAt: r.started_at, endedAt: r.ended_at ?? undefined, stopReason: r.stop_reason ?? undefined,
      tokensIn: r.tokens_in, tokensOut: r.tokens_out,
      verdict: r.verdict_json ? JSON.parse(r.verdict_json) : undefined,
      exitReason: r.exit_reason ?? undefined,
    }));
  }

  regenerateCurrentMd(mdPath: string, projectId: string): void {
    const units: any[] = this.db.prepare(
      "SELECT * FROM work_units WHERE project_id=? ORDER BY updated_at DESC").all(projectId);
    // current.md is a stack of Briefs (decision-ready), not the raw per-role-run log — that detail
    // stays queryable in the `runs` table for forensics.
    const lines = [`# Chakravyuh — current (${new Date().toISOString()})`, ""];
    for (const u of units) {
      const unit: WorkUnit = {
        id: u.id, projectId: u.project_id, slug: u.slug, title: u.title, spec: u.spec,
        status: u.status, attempt: u.attempt, maxAttempts: u.max_attempts,
        createdAt: u.created_at, updatedAt: u.updated_at,
      };
      lines.push(briefFor(unit, this.runsForUnit(u.id)));
      lines.push("");
    }
    writeFileSync(mdPath, lines.join("\n"));
  }

  /**
   * `--all`'s cross-process drain lease: an atomic compare-and-swap acquire on the single
   * `drain_lock` row. Succeeds (returns `true`) iff the row is unheld (`holder IS NULL`) or its
   * last heartbeat is older than `now - ttlMs` (stale — the prior holder is presumed dead), and
   * exactly one row was updated. On success the row is stamped with `holder`/`host`/`now` in the
   * same statement (no separate write), so a race between two acquirers can only let one through.
   */
  acquireLease(holder: string, host: string, now: number, ttlMs: number): boolean {
    const staleBefore = now - ttlMs;
    const result = this.db.prepare(
      `UPDATE drain_lock SET holder=?, host=?, heartbeat=?
       WHERE name='drain' AND (holder IS NULL OR heartbeat < ?)`,
    ).run(holder, host, now, staleBefore);
    return result.changes === 1;
  }

  /**
   * Refreshes the held lease's heartbeat timestamp. A no-op if `holder` no longer holds it (e.g.
   * it was reclaimed as stale) — the caller's next heartbeat tick simply has no effect.
   */
  heartbeatLease(holder: string, now: number): void {
    this.db.prepare(`UPDATE drain_lock SET heartbeat=? WHERE name='drain' AND holder=?`).run(now, holder);
  }

  /**
   * Frees the lease, but only if `holder` is still the current holder — releasing with a stale
   * or wrong holder id is a no-op, never a steal-back of someone else's lease.
   */
  releaseLease(holder: string): void {
    this.db.prepare(
      `UPDATE drain_lock SET holder=NULL, host=NULL, heartbeat=NULL WHERE name='drain' AND holder=?`,
    ).run(holder);
  }

  /**
   * The current lease state, for the `--all` contention error message. `holder`/`host`/`heartbeat`
   * are all `null` when unheld.
   */
  getLease(): { holder: string | null; host: string | null; heartbeat: number | null } {
    const r: any = this.db.prepare(`SELECT holder, host, heartbeat FROM drain_lock WHERE name='drain'`).get();
    return { holder: r?.holder ?? null, host: r?.host ?? null, heartbeat: r?.heartbeat ?? null };
  }

  /**
   * Closes the underlying database handle. Call once the CLI is done with the store.
   */
  close(): void { this.db.close(); }
}
