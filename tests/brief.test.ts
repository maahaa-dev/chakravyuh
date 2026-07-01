import { describe, it, expect } from "vitest";
import { briefFor } from "../src/store/brief.js";
import { newWorkUnit, withStatus, type Run } from "../src/domain.js";

function run(p: Partial<Run>): Run {
  return {
    id: p.id ?? "r1", workUnitId: p.workUnitId ?? "u1", role: p.role ?? "maker",
    attempt: p.attempt ?? 1, provider: p.provider ?? "anthropic", model: p.model ?? "claude",
    thinking: p.thinking ?? "low", startedAt: p.startedAt ?? new Date().toISOString(),
    tokensIn: p.tokensIn ?? 10, tokensOut: p.tokensOut ?? 10,
    ...p,
  };
}

describe("briefFor", () => {
  it("approved unit: status + branch/commit + one-line summary, NO per-run dump", () => {
    const unit = withStatus(
      newWorkUnit({ projectId: "p", slug: "cli-list", title: "Add --list flag", spec: "..." }),
      "approved", 1,
    );
    const runs: Run[] = [
      run({ id: "r1", role: "maker", stopReason: "stop" }),
      run({ id: "r2", role: "checker", stopReason: "stop",
        verdict: { pass: true, summary: "Matches spec: --list prints backlog units.", blockers: [], evidence: [] } }),
      run({ id: "r3", role: "reviewer", stopReason: "stop",
        verdict: { pass: true, summary: "Clean, matches conventions.", blockers: [], evidence: [] } }),
    ];

    const brief = briefFor(unit, runs);

    expect(brief).toMatch(/approved/);
    expect(brief).toMatch(/attempt 1\/3/);
    expect(brief).toMatch(/chakravyuh\/cli-list/);
    expect(brief).toMatch(/Clean, matches conventions\./);
    // no per-run dump: none of the raw run ids/roles are individually itemized
    expect(brief).not.toMatch(/r1/);
    expect(brief).not.toMatch(/\bmaker a1\b/);
    expect(brief).not.toMatch(/\bchecker a1\b/);
  });

  it("failed unit: includes the blocking verdict summary", () => {
    const unit = withStatus(
      newWorkUnit({ projectId: "p", slug: "cli-list", title: "Add --list flag", spec: "..." }),
      "failed", 3,
    );
    const runs: Run[] = [
      run({ id: "r1", role: "maker", stopReason: "stop" }),
      run({ id: "r2", role: "checker", stopReason: "stop",
        verdict: { pass: false, summary: "Missing: --list omits archived units.", blockers: ["Add archived units to --list output."], evidence: [] } }),
    ];

    const brief = briefFor(unit, runs);

    expect(brief).toMatch(/failed/);
    expect(brief).toMatch(/Missing: --list omits archived units\./);
    expect(brief).toMatch(/Add archived units to --list output\./);
  });
});
