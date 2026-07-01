import { randomUUID } from "node:crypto";
import type { Budget, GateResult, Project, Run, WorkUnit } from "./domain.js";
import { withStatus } from "./domain.js";
import type { WorkStore } from "./store/work-store.js";
import type { PiSpawnOpts, PiSpawnResult } from "./pi.js";
import { createFileTee } from "./pi-log.js";
import { parseVerdict } from "./verdict.js";
import {
  MAKER_BRIEF, CHECKER_BRIEF, REVIEWER_BRIEF, checkContract, reviewContract, renderBlockers,
} from "./briefs.js";

/**
 * Model routing for one role — which provider, model, and thinking level its spawns use.
 */
export interface RoleConfig { provider: string; model: string; thinking: string; }

/**
 * Every side-effecting capability {@link runUnit} needs, injected rather than imported. This is the
 * seam that makes the loop core fully unit-testable: tests pass fakes for the store, `spawn`, git
 * ops, and `stopRequested`, and assert the loop's branching without touching Pi, git, or disk.
 */
export interface LoopDeps {
  store: WorkStore;
  spawn: (o: PiSpawnOpts) => Promise<PiSpawnResult>;
  runHealth: (cmd: string, cwd: string, timeoutMs?: number) => GateResult;
  addWorktree: (p: Project, slug: string) => string;
  removeWorktree: (p: Project, worktreePath: string) => void;
  deleteBranch: (root: string, branch: string) => void;
  rootIsClean: (root: string) => boolean;
  commitAll: (wt: string, msg: string) => void;
  /**
   * Polled at each safe point; a truthy result halts the unit as `blocked` (STOP/PAUSE control file).
   */
  stopRequested: () => boolean;
  roles: { maker: RoleConfig; checker: RoleConfig; reviewer: RoleConfig };
  budget: Budget;
  piBinPath?: string;
  sandbox?: boolean;
  extensions?: string[];
  /**
   * Directory for per-run stdout logs (see {@link piLogPath}), wired from config and kept outside
   * `project.root` (leak guard). Omit to skip logging.
   */
  logDir?: string;
}

function recordRun(
  deps: LoopDeps, unit: WorkUnit, role: Run["role"], cfg: RoleConfig,
  res: PiSpawnResult, startedAt: string, verdict?: Run["verdict"],
): void {
  deps.store.saveRun({
    id: randomUUID(), workUnitId: unit.id, role, attempt: unit.attempt,
    provider: cfg.provider, model: cfg.model, thinking: cfg.thinking,
    sessionId: res.sessionId, startedAt, endedAt: new Date().toISOString(),
    stopReason: res.stopReason, tokensIn: res.tokensIn, tokensOut: res.tokensOut,
    verdict, exitReason: res.exitReason,
  });
}

function piOpts(
  deps: LoopDeps, role: Run["role"], cfg: RoleConfig, cwd: string,
  unit: WorkUnit, tools: string, brief: string, prompt: string,
): PiSpawnOpts {
  return {
    role, cwd, provider: cfg.provider, model: cfg.model, thinking: cfg.thinking, tools,
    sessionId: `${unit.id}-${role}-${unit.attempt}`, brief, prompt,
    idleTimeoutMs: deps.budget.idleTimeoutMs, hardTimeoutMs: deps.budget.hardTimeoutMs,
    binPath: deps.piBinPath, sandbox: deps.sandbox, extensions: deps.extensions,
    tee: deps.logDir != null ? createFileTee(deps.logDir, unit.slug, role, unit.attempt) : undefined,
  };
}

/**
 * Drives one work unit through the maker → gate → (checker ∥ reviewer) loop with bounded retries —
 * the heart of the harness. Each attempt spawns the maker (sandboxed, write-capable), runs the
 * authoritative health gate, and — only once the gate passes — the read-only checker (Spec axis)
 * and independent reviewer (Standards axis) as two separate, concurrent Pi processes (`Promise.all`;
 * `spawnPi` never rejects, so no `allSettled` is needed). A red gate short-circuits both verifiers
 * entirely. Any failure injects axis-labeled blocker feedback and retries until the attempt or token
 * budget is spent. On success it commits on `chakravyuh/<slug>` and returns `approved`. The `finally`
 * cleanup keeps the worktree and branch on `blocked`, keeps just the branch on `approved`, and drops
 * both otherwise.
 *
 * Returns the final {@link WorkUnit} carrying its terminal status; never throws for a loop outcome —
 * failures are encoded in the returned status.
 */
export async function runUnit(project: Project, unit: WorkUnit, deps: LoopDeps): Promise<WorkUnit> {
  let current = unit;
  // Move to a status, persisting it. Keeps the in-memory unit and the store row in lockstep.
  const setStatus = (status: WorkUnit["status"], attempt = current.attempt): void => {
    current = withStatus(current, status, attempt);
    deps.store.setStatus(current.id, current.status, current.attempt);
  };
  const fail = (status: WorkUnit["status"]): WorkUnit => { setStatus(status); return current; };

  if (deps.stopRequested()) return fail("blocked");

  // NOTE: no pre-gate health check on project.root by design (Slice 1). A bug-fix work unit's
  // baseline is intentionally red (the failing test IS the bug). The authoritative gate-AFTER on
  // the worktree + the root-leak guard are the safety net. Slice 2 may add a per-unit-type
  // gate-before for feature units (which expect a clean baseline).
  const worktree = deps.addWorktree(project, current.slug);
  const cleanup = (): void => {
    // blocked = STOP/PAUSE (operator-initiated, temporary): leave the worktree AND branch intact
    // so in-progress work survives for inspection/resume — do not discard it on a pause.
    // approved: drop the worktree dir but KEEP branch chakravyuh/<slug> for the human to merge.
    // failed: drop both the worktree and the throwaway branch.
    if (current.status === "blocked") return;
    try { deps.removeWorktree(project, worktree); } catch { /* best effort */ }
    if (current.status !== "approved") {
      try { deps.deleteBranch(project.root, `chakravyuh/${current.slug}`); } catch { /* best effort */ }
    }
  };

  // Cumulative token backstop across all runs of this unit (a runaway guard, not a precise meter).
  // Enforced BEFORE spawning the next role/attempt — never after the final role, so it can stop
  // further spending without discarding work that has already earned approval.
  let tokensSpent = 0;
  const cap = deps.budget.maxTokensPerUnit;
  const addTokens = (res: PiSpawnResult): void => { tokensSpent += res.tokensIn + res.tokensOut; };
  const overCap = (): boolean => cap !== undefined && tokensSpent > cap;

  try {
    // Append-only ledger of per-attempt failure context.
    // Attempt N's maker prompt shows labelled blockers from attempts 1..N-1 (most-recent last).
    // Built immutably each iteration — prior entries are never mutated, only spread into a new array.
    // Stays naturally small because attempts are capped by maxAttemptsPerUnit.
    let failureLedger: ReadonlyArray<{ readonly attempt: number; readonly context: string }> = [];
    const noteBlocker = (context: string): void => {
      failureLedger = [...failureLedger, { attempt: current.attempt, context }];
    };

    while (current.attempt < deps.budget.maxAttemptsPerUnit) {
      if (deps.stopRequested()) return fail("blocked");
      if (overCap()) return fail("failed"); // don't start a new attempt over budget
      setStatus("building", current.attempt + 1);

      // Derive the cumulative feedback string immutably from the ledger.
      // Each entry is labelled with its attempt number so the maker can see the full history.
      const failureContext = failureLedger.length === 0
        ? ""
        : failureLedger.map(e => `### Attempt ${e.attempt} blockers\n${e.context}`).join("\n\n");

      // MAKER
      const makerStart = new Date().toISOString();
      const makerRes = await deps.spawn(piOpts(
        deps, "maker", deps.roles.maker, worktree, current,
        "read,bash,edit,write", MAKER_BRIEF, current.spec + (failureContext ? `\n\n${failureContext}` : "")));
      recordRun(deps, current, "maker", deps.roles.maker, makerRes, makerStart);
      addTokens(makerRes);
      if (!deps.rootIsClean(project.root)) return fail("failed");
      // ONE cap check guards the whole gate + verifier-pair section below (the gate itself never
      // spends tokens, and the between-checker-reviewer cap check is intentionally dropped: both
      // verifiers now spawn together, and either may overshoot the cap by one run).
      if (overCap()) return fail("failed"); // don't spawn the checker+reviewer pair over budget
      if (makerRes.stopReason !== "stop") {
        noteBlocker("Maker did not complete; retry.");
        continue;
      }
      if (deps.stopRequested()) return fail("blocked");

      // GATE (authoritative). Bound by the same hard timeout as a spawn — a hung health command
      // (e.g. an infinite test loop) would otherwise stall the loop forever; the gate had no timeout.
      // A red gate short-circuits BOTH verifiers below (spec/standards judgement is moot if the
      // health check itself fails) but its output still drives the retry feedback.
      setStatus("checking");
      const gateAfter = deps.runHealth(project.healthCmd, worktree, deps.budget.hardTimeoutMs);
      if (gateAfter.exitCode !== 0) {
        noteBlocker(renderBlockers([], gateAfter));
        continue;
      }
      if (deps.stopRequested()) return fail("blocked");

      // CHECKER (Spec axis) + REVIEWER (Standards axis): independent, read-only, data-independent
      // (the reviewer does not consume the checker's output) — spawned as two SEPARATE Pi processes
      // (own tools, own session ids) under Promise.all to halve verification latency. Only ONE cap
      // check (above, after the maker) guards this pair; both may overshoot the cap by one run
      // (a runaway backstop, not a precise meter), never a reason to discard an approved attempt.
      setStatus("reviewing");
      const checkStart = new Date().toISOString();
      const reviewStart = new Date().toISOString();
      const [checkRes, reviewRes] = await Promise.all([
        deps.spawn(piOpts(
          deps, "checker", deps.roles.checker, worktree, current,
          "read,grep,find,ls", CHECKER_BRIEF, checkContract(current, gateAfter))),
        deps.spawn(piOpts(
          deps, "reviewer", deps.roles.reviewer, worktree, current,
          "read,grep,find,ls", REVIEWER_BRIEF, reviewContract(current))),
      ]);
      const cVerdict = parseVerdict(checkRes.text, [gateAfter]);
      const rVerdict = parseVerdict(reviewRes.text);
      // Recorded checker-then-reviewer regardless of which spawn actually finished first, so the
      // reviewer keeps the higher store `seq` and brief.ts's most-recent-verdict lookup is unchanged.
      recordRun(deps, current, "checker", deps.roles.checker, checkRes, checkStart, cVerdict);
      recordRun(deps, current, "reviewer", deps.roles.reviewer, reviewRes, reviewStart, rVerdict);
      addTokens(checkRes);
      addTokens(reviewRes); // accounted, but this is the last spawn pair — do not fail-after.
      if (!cVerdict.pass || !rVerdict.pass) {
        noteBlocker(renderBlockers([
          { axis: "Spec", verdict: cVerdict },
          { axis: "Standards", verdict: rVerdict },
        ]));
        continue;
      }

      // The maker may have produced no changes (spec already satisfied / it edited nothing). An
      // empty `git commit` would throw and crash the run, so treat a clean worktree as an
      // incomplete attempt and retry rather than committing nothing.
      if (deps.rootIsClean(worktree)) {
        noteBlocker("The worktree has no changes to commit; modify files to satisfy the spec.");
        continue;
      }

      deps.commitAll(worktree, `feat(${current.slug}): ${current.title}`);
      setStatus("approved");
      return current;
    }
    return fail("failed");
  } finally {
    cleanup();
  }
}
