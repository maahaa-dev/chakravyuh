import type { GateResult, Verdict, WorkUnit } from "./domain.js";

const VERDICT_INSTRUCTION =
  'End your final message with a fenced json block exactly like:\n' +
  '```json\n{"pass": true, "summary": "one line", "blockers": []}\n```\n' +
  'Set pass=false and list concrete blockers if the work is not acceptable.';

/**
 * System prompt for the maker role: red-green-refactor TDD, small, worktree-confined, and explicitly
 * forbidden from committing (Chakravyuh commits only on approval).
 */
export const MAKER_BRIEF =
  "You are the MAKER. Implement the work unit's vertical slice using red-green-refactor TDD: " +
  "write a failing test first (red), write the minimal code to make it pass (green), then clean up " +
  "the implementation without changing behaviour (refactor). Keep changes small and confined to this " +
  "worktree. Do not commit; Chakravyuh commits on approval.";

const FOWLER_SMELL_BASELINE =
  "Baseline smell checklist (Fowler): Mysterious Name, Duplicated Code, Feature Envy, Data Clumps, " +
  "Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change, Speculative Generality, " +
  "Message Chains, Middle Man, Refused Bequest. For each smell you flag: name it, quote the hunk it " +
  "appears in, and propose the refactor.";

const REVIEWER_BINDING_RULES =
  "Two binding rules: (1) repo standards override the baseline — if a documented repo convention " +
  "conflicts with a baseline smell, the repo convention wins; (2) baseline smells are ALWAYS " +
  "judgement calls, never hard blockers — skip anything tooling (linter, formatter, type checker) " +
  "already enforces, and do not fail the review on a baseline smell alone unless it also breaks a " +
  "documented repo standard.";

/**
 * System prompt for the checker role: the Spec axis. Read-only inspection of the diff and tests
 * against the unit's acceptance criteria — missing/partial requirements, scope creep, and
 * requirements implemented wrongly — quoting the spec for each, ending in the structured verdict
 * block.
 */
export const CHECKER_BRIEF =
  "You are the CHECKER. You are read-only. You judge the Spec axis: does the change satisfy the " +
  "work unit's acceptance? Inspect the diff and tests against the spec and report, for each finding, " +
  "a quote from the spec: (a) missing or partial requirements, (b) scope creep — behaviour that was " +
  "not asked for, (c) requirements implemented wrongly. Do not attempt to edit. " + VERDICT_INSTRUCTION;

/**
 * System prompt for the reviewer role: the Standards axis. An independent, read-only judgement of
 * the still-uncommitted working tree against repo conventions plus the Fowler smell baseline, with
 * two binding rules: repo standards override the baseline, and baseline smells are always judgement
 * calls, never hard blockers (unless they also break a documented standard).
 */
export const REVIEWER_BRIEF =
  "You are the REVIEWER, independent of the maker. You are read-only. You judge the Standards axis: " +
  "repo conventions and the baseline smell checklist below. The maker's change is in the working " +
  "tree and NOT yet committed (Chakravyuh commits only on approval). " +
  FOWLER_SMELL_BASELINE + " " + REVIEWER_BINDING_RULES + " " + VERDICT_INSTRUCTION;

/**
 * System prompt for the reflector role: read-only meta-analysis of a scored trace digest plus the
 * raw per-run logs, hunting for harness weaknesses and proposing specific prose edits to the briefs
 * (maker/checker/reviewer prompts, Fowler baseline, binding rules, verdict contract) with rationale,
 * plus a draft backlog unit. The reflector is advisory only and is explicitly forbidden from editing
 * anything itself.
 */
export const REFLECTOR_BRIEF =
  "You are the REFLECTOR. You are read-only and advisory: you are explicitly forbidden from editing " +
  "any file, brief, or backlog unit yourself. Read the scored trace digest plus the raw per-run logs " +
  "to find weaknesses in the harness itself \u2014 not just this one work unit. Look for patterns such " +
  "as verifiers missing real defects, blockers that don't map to the spec, ambiguous binding rules, " +
  "or maker/checker/reviewer prompts that invite the wrong behaviour. For each weakness you find, " +
  "propose a SPECIFIC edit to the briefs prose \u2014 quoting the current text of the MAKER_BRIEF, " +
  "CHECKER_BRIEF, REVIEWER_BRIEF, the Fowler smell baseline, the binding rules, or the verdict " +
  "contract \u2014 along with your proposed replacement text and the rationale for the change. Also " +
  "draft a backlog unit (title + spec) that a human or Chakravyuh could enqueue to make the edit. " +
  "Do not modify any file; only report findings, proposed edits, and the draft backlog unit.";

/**
 * Builds the checker's per-turn prompt: the spec plus the authoritative gate result, asking for a
 * verdict on the working-tree diff.
 */
export function checkContract(unit: WorkUnit, gate: GateResult): string {
  const parts = [
    `Spec:\n${unit.spec}`,
    `Chakravyuh ran the health gate: exit code ${gate.exitCode} (\`${gate.command}\`).`,
  ];
  // On a failed gate, hand the checker the actual output so its verdict reasons about the real
  // failure instead of just an exit code.
  if (gate.exitCode !== 0 && gate.output) parts.push(`Health gate output:\n${gate.output}`);
  parts.push("Review the working tree diff and tests. Emit your verdict json.");
  return parts.join("\n\n");
}

/**
 * Builds the reviewer's per-turn prompt: the spec plus an instruction to review the uncommitted diff
 * via `git diff` (not `git log`/`git show`, since the change is not yet committed).
 */
export function reviewContract(unit: WorkUnit): string {
  return [
    `Spec:\n${unit.spec}`,
    "Independently review the uncommitted working-tree diff on this branch (use `git diff`, " +
      "not `git log`/`git show` — the change is not committed yet). Emit your verdict json.",
  ].join("\n\n");
}

/**
 * One axis's verdict, labeled for merged retry feedback: the checker judges `Spec`, the reviewer
 * judges `Standards`.
 */
export interface AxisVerdict {
  axis: "Spec" | "Standards";
  verdict: Verdict;
}

/**
 * Renders the checker's and reviewer's verdicts (and a failed gate, if any) into the merged retry
 * feedback prepended to the maker's next-attempt prompt, under one `Previous attempt rejected`
 * header. Only FAILING verdicts contribute blockers, each prefixed with its axis label so the maker
 * knows whether a blocker is a spec gap or a standards violation. Pass an empty array when a red
 * gate short-circuited both verifiers — the gate's own output still surfaces below.
 */
export function renderBlockers(verdicts: AxisVerdict[], gate?: GateResult): string {
  const parts = ["Previous attempt rejected. Address these and retry:"];
  for (const { axis, verdict } of verdicts) {
    if (verdict.pass) continue;
    for (const b of verdict.blockers) parts.push(`- [${axis}] ${b}`);
  }
  if (gate && gate.exitCode !== 0) {
    parts.push(`- health gate failed: exit code ${gate.exitCode} (\`${gate.command}\`)`);
    if (gate.output) parts.push(`  gate output:\n${gate.output}`);
  }
  return parts.join("\n");
}
