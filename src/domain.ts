/**
 * A target repository Chakravyuh drives a loop against. One config names one project.
 */
export interface Project {
  id: string;
  /**
   * Absolute path to the target repo. The loop never edits this tree directly — it watches
   * it for leaks (the maker must only touch the worktree).
   */
  root: string;
  /**
   * Directory under which per-unit worktrees are created. Must live outside {@link Project.root}
   * so a worktree is never rsync'd or committed as part of the project itself.
   */
  worktreeBase: string;
  /**
   * Branch each unit's worktree forks from, and the base the commit-advance guard measures against.
   */
  baseBranch: string;
  /**
   * Shell command that is the deterministic, authoritative pass/fail gate. Model verdicts never
   * override its exit code.
   */
  healthCmd: string;
  /**
   * Confine the maker's writes with the macOS Seatbelt allowlist. Off-darwin this warns and
   * passes through (Linux bubblewrap is a TODO), so on Linux the maker runs unsandboxed.
   *
   * @default true
   */
  sandbox?: boolean;
  /**
   * Bounds concurrent units in `--all`'s parallel drain (see `schedule.ts`). `1` is the sequential
   * regression guard — same order, same statuses, same exit code as the old plain `for` loop.
   *
   * @default 2
   */
  maxParallel?: number;
}

/**
 * A work unit's lifecycle state. The first four are transient (a run is in flight); the last four
 * are terminal outcomes:
 * - `pending` — parsed from the backlog, not yet started.
 * - `building` — the maker is running.
 * - `checking` — health gate plus the read-only checker.
 * - `reviewing` — the independent reviewer is running.
 * - `approved` — passed every gate, committed; the branch is kept for a human to merge.
 * - `blocked` — halted by STOP/PAUSE; worktree and branch are preserved for resume.
 * - `failed` — attempts or token budget exhausted, a root leak, or the maker changed nothing.
 * - `done` — terminal-complete; treated like `approved` for the idempotent skip.
 */
export type WorkUnitStatus =
  | "pending" | "building" | "checking" | "reviewing"
  | "approved" | "blocked" | "failed" | "done";

/**
 * One unit of work — a single backlog spec the loop drives from `pending` to a terminal status.
 */
export interface WorkUnit {
  /**
   * Deterministic id `projectId:slug` (unless a caller overrides it), so re-parsing the same
   * backlog maps to the same store row instead of minting a fresh unit every run.
   */
  id: string;
  projectId: string;
  slug: string;
  title: string;
  /**
   * The free-text requirement the maker implements and the checker/reviewer judge against.
   */
  spec: string;
  status: WorkUnitStatus;
  /**
   * How many maker→gate→checker→reviewer attempts have been spent on this unit.
   */
  attempt: number;
  /**
   * Attempt ceiling; the loop fails the unit rather than retrying past it.
   */
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Which role a Pi spawn plays in the loop. The tool allowlist and provider differ per role to
 * keep maker ≠ checker ≠ reviewer:
 * - `maker` writes code (`read,bash,edit,write`).
 * - `checker` verifies the diff read-only (`read,grep,find,ls`).
 * - `reviewer` judges independently, read-only, and should run on a different provider.
 */
export type Role = "maker" | "checker" | "reviewer";

/**
 * Outcome of one {@link Project.healthCmd} run. `exitCode` 0 means the gate passed.
 */
export interface GateResult {
  command: string;
  exitCode: number;
  durationMs: number;
  /**
   * The tail of the gate command's combined stdout+stderr, bounded in size. Captured so a failed
   * gate is debuggable and can be fed to the checker as evidence — absent when no output was produced.
   */
  output?: string;
}

/**
 * A checker's or reviewer's structured judgement, parsed from the trailing ```json``` block of its
 * output. `blockers` are the concrete retry feedback; `evidence` carries the gate results that the
 * verdict was rendered against.
 */
export interface Verdict { pass: boolean; summary: string; blockers: string[]; evidence: GateResult[]; }

/**
 * A persisted record of one role-run within an attempt — what was spawned, what it cost, and how
 * it ended. Saved to the store for idempotency and the `current.md` digest.
 */
export interface Run {
  id: string;
  workUnitId: string;
  role: Role;
  attempt: number;
  provider: string;
  model: string;
  thinking: string;
  sessionId?: string;
  startedAt: string;
  endedAt?: string;
  /**
   * How the agent turn ended. `stop` is the only success; a non-terminal Pi stopReason (e.g.
   * `toolUse`) is normalized to `error`.
   */
  stopReason?: "stop" | "error" | "aborted" | "timeout";
  tokensIn: number;
  tokensOut: number;
  verdict?: Verdict;
  /**
   * Free-text process detail behind {@link Run.stopReason} — e.g. `exit:N`, `hard-timeout`,
   * `idle-timeout`, `spawn-error`.
   */
  exitReason?: string;
}

/**
 * The external bounds on a unit — trusted instead of the model's self-reported cost. Any one
 * exceeded fails the unit.
 */
export interface Budget {
  maxAttemptsPerUnit: number;
  /**
   * Idle timeout: the maker subprocess is killed if it emits nothing on stdout/stderr for this long.
   */
  idleTimeoutMs: number;
  /**
   * Absolute wall-clock ceiling for a single spawn, regardless of activity.
   */
  hardTimeoutMs: number;
  /**
   * Cumulative (tokensIn+tokensOut) across all runs of a unit. Exceeding it fails the unit —
   * a runaway backstop, not a precise cost meter (per-turn input is cache-discounted).
   */
  maxTokensPerUnit?: number;
}

/**
 * Conservative default bounds: 3 attempts, 10-minute idle / 30-minute hard timeouts, and a
 * 1,000,000-token runaway backstop.
 */
export const DEFAULT_BUDGET: Budget = {
  maxAttemptsPerUnit: 3,
  idleTimeoutMs: 10 * 60_000,
  hardTimeoutMs: 30 * 60_000,
  maxTokensPerUnit: 1_000_000,
};

/**
 * Builds a fresh {@link WorkUnit} with sane defaults and a deterministic id, used by the backlog
 * parser per section. Pass an explicit `id` to override the `projectId:slug` derivation.
 */
export function newWorkUnit(
  p: Pick<WorkUnit, "projectId" | "slug" | "title" | "spec"> & Partial<WorkUnit>,
): WorkUnit {
  const now = new Date().toISOString();
  return {
    // Deterministic by project+slug so re-parsing the same backlog maps to the SAME store row
    // (lets the CLI see a unit's prior status instead of minting a fresh id every run). A caller
    // can still pass an explicit id.
    id: p.id ?? `${p.projectId}:${p.slug}`,
    projectId: p.projectId,
    slug: p.slug,
    title: p.title,
    spec: p.spec,
    status: p.status ?? "pending",
    attempt: p.attempt ?? 0,
    maxAttempts: p.maxAttempts ?? 3,
    createdAt: p.createdAt ?? now,
    updatedAt: p.updatedAt ?? now,
  };
}

/**
 * Returns a copy of the unit with a new status and attempt count, stamping `updatedAt`. Immutable —
 * the input is never mutated.
 */
export function withStatus(u: WorkUnit, status: WorkUnitStatus, attempt: number): WorkUnit {
  return { ...u, status, attempt, updatedAt: new Date().toISOString() };
}
