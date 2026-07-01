import type { Run, WorkUnit, WorkUnitStatus } from "../domain.js";

/**
 * Persistence boundary for work units and run facts — the repository seam that keeps the loop
 * storage-agnostic and mockable. {@link SqliteStore} is the production implementation; tests pass a
 * fake.
 */
export interface WorkStore {
  /**
   * Inserts the unit, or updates it in place if its id already exists (idempotent re-parse).
   */
  upsertWorkUnit(u: WorkUnit): void;
  getWorkUnit(id: string): WorkUnit | null;
  /**
   * Every stored work unit, across all projects, for `status` reporting.
   */
  allUnits(): WorkUnit[];
  setStatus(id: string, status: WorkUnitStatus, attempt: number): void;
  /**
   * Appends one immutable run record. The implementation assigns a global sequence for ordering.
   */
  saveRun(run: Run): void;
  runsForUnit(workUnitId: string): Run[];
  /**
   * Every stored run, across all units, ordered by the store's global sequence, for `status`
   * reporting.
   */
  allRuns(): Run[];
  /**
   * Rewrites the human-readable `current.md` digest for a project from the stored units and runs.
   */
  regenerateCurrentMd(mdPath: string, projectId: string): void;
}
