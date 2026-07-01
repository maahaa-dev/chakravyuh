import { describe, it, expect, vi } from "vitest";
import { runUnit } from "../src/loop.js";
import { SqliteStore } from "../src/store/sqlite-store.js";
import { newWorkUnit, DEFAULT_BUDGET, type Project } from "../src/domain.js";
import type { PiSpawnResult } from "../src/pi.js";

// Checker and reviewer are independent, read-only judges of the same maker output — this suite
// verifies they run as two SEPARATE Pi processes under Promise.all (own session ids / tools),
// that a red gate short-circuits BOTH, and that the approve-vs-block outcome for a given set of
// verdicts matches what the old sequential loop would have decided.

const project: Project = {
  id: "p", root: "/tmp/x", worktreeBase: "/tmp/wt", baseBranch: "main", healthCmd: "true",
};
const roles = {
  maker: { provider: "anthropic", model: "strong", thinking: "medium" },
  checker: { provider: "anthropic", model: "cheap", thinking: "low" },
  reviewer: { provider: "openai", model: "gpt", thinking: "low" },
};

function baseDeps(over: Partial<Parameters<typeof runUnit>[2]> = {}) {
  const store = new SqliteStore(":memory:");
  return {
    deps: {
      store,
      spawn: vi.fn(),
      runHealth: vi.fn(() => ({ command: "true", exitCode: 0, durationMs: 1 })),
      addWorktree: vi.fn(() => "/tmp/wt/s"),
      removeWorktree: vi.fn(),
      deleteBranch: vi.fn(),
      rootIsClean: vi.fn((dir: string) => dir === project.root),
      commitAll: vi.fn(),
      stopRequested: () => false,
      roles, budget: DEFAULT_BUDGET, ...over,
    },
    store,
  };
}

const okSpawn = (text: string, extra: Partial<PiSpawnResult> = {}): PiSpawnResult =>
  ({ sessionId: "s", stopReason: "stop", tokensIn: 1, tokensOut: 1, text, exitReason: "exit:0", ...extra });
const PASS = 'ok\n```json\n{"pass":true,"summary":"ok","blockers":[]}\n```';
const FAIL = (msg: string) => `no\n\`\`\`json\n{"pass":false,"summary":"bad","blockers":["${msg}"]}\n\`\`\``;

function unit() { return newWorkUnit({ id: "u1", projectId: "p", slug: "s", title: "t", spec: "do" }); }

describe("runUnit — parallel checker + reviewer", () => {
  it("both checker and reviewer spawns are invoked for one attempt, as two separate processes", async () => {
    const { deps, store } = baseDeps();
    (deps.spawn as any).mockImplementation(async (o: any) =>
      okSpawn(o.tools.includes("write") ? "made it" : PASS));
    const u = unit();
    store.upsertWorkUnit(u);

    const out = await runUnit(project, u, deps);
    expect(out.status).toBe("approved");

    const calls = (deps.spawn as any).mock.calls.map((c: any[]) => c[0]);
    const checkerCall = calls.find((o: any) => o.role === "checker");
    const reviewerCall = calls.find((o: any) => o.role === "reviewer");
    expect(checkerCall).toBeDefined();
    expect(reviewerCall).toBeDefined();
    // Separate processes: distinct session ids, distinct providers/tools — never a shared context.
    expect(checkerCall.sessionId).not.toBe(reviewerCall.sessionId);
    expect(checkerCall.provider).toBe("anthropic");
    expect(reviewerCall.provider).toBe("openai");

    // Both runs recorded, checker before reviewer regardless of resolution order.
    const runs = store.runsForUnit(u.id);
    const checkerRun = runs.find((r) => r.role === "checker")!;
    const reviewerRun = runs.find((r) => r.role === "reviewer")!;
    expect(checkerRun).toBeDefined();
    expect(reviewerRun).toBeDefined();
  });

  it("a red gate short-circuits both verifiers — neither checker nor reviewer spawns", async () => {
    const { deps, store } = baseDeps({
      runHealth: vi.fn(() => ({ command: "x", exitCode: 1, durationMs: 1, output: "boom" })),
    });
    (deps.spawn as any).mockImplementation(async (o: any) =>
      okSpawn(o.tools.includes("write") ? "made it" : PASS));
    const u = unit();
    store.upsertWorkUnit(u);

    const out = await runUnit(project, u, deps);
    expect(out.status).toBe("failed");
    const roleCalls = (deps.spawn as any).mock.calls.map((c: any[]) => c[0].role);
    expect(roleCalls).not.toContain("checker");
    expect(roleCalls).not.toContain("reviewer");
    // still surfaced in retry feedback, even though maxAttempts is spent retrying with it
    expect(roleCalls.filter((r: string) => r === "maker").length).toBe(DEFAULT_BUDGET.maxAttemptsPerUnit);
  });

  it("checker-pass / reviewer-fail blocks approval with the reviewer's blockers in the feedback", async () => {
    const { deps, store } = baseDeps();
    const seenPrompts: string[] = [];
    (deps.spawn as any).mockImplementation(async (o: any) => {
      if (o.tools.includes("write")) { seenPrompts.push(o.prompt); return okSpawn("made it"); }
      if (o.role === "checker") return okSpawn(PASS);
      return okSpawn(FAIL("standards violation: duplicated code"));
    });
    const u = unit();
    store.upsertWorkUnit(u);

    const out = await runUnit(project, u, deps);
    expect(out.status).toBe("failed"); // exhausts retries since reviewer never passes here
    const feedbackPrompt = seenPrompts.find((p) => p.includes("Previous attempt rejected"));
    expect(feedbackPrompt).toBeDefined();
    expect(feedbackPrompt).toMatch(/\[Standards\] standards violation: duplicated code/);
    expect(feedbackPrompt).not.toMatch(/\[Spec\]/);
  });

  it("checker-fail / reviewer-pass blocks approval with the checker's blockers in the feedback", async () => {
    const { deps, store } = baseDeps();
    const seenPrompts: string[] = [];
    (deps.spawn as any).mockImplementation(async (o: any) => {
      if (o.tools.includes("write")) { seenPrompts.push(o.prompt); return okSpawn("made it"); }
      if (o.role === "checker") return okSpawn(FAIL("spec gap: missing validation"));
      return okSpawn(PASS);
    });
    const u = unit();
    store.upsertWorkUnit(u);

    const out = await runUnit(project, u, deps);
    expect(out.status).toBe("failed");
    const feedbackPrompt = seenPrompts.find((p) => p.includes("Previous attempt rejected"));
    expect(feedbackPrompt).toBeDefined();
    expect(feedbackPrompt).toMatch(/\[Spec\] spec gap: missing validation/);
    expect(feedbackPrompt).not.toMatch(/\[Standards\]/);
  });

  it("matches the sequential loop's approve-vs-block outcome for every verdict combination", async () => {
    const cases: Array<{ checkerPass: boolean; reviewerPass: boolean; expectApproved: boolean }> = [
      { checkerPass: true, reviewerPass: true, expectApproved: true },
      { checkerPass: true, reviewerPass: false, expectApproved: false },
      { checkerPass: false, reviewerPass: true, expectApproved: false },
      { checkerPass: false, reviewerPass: false, expectApproved: false },
    ];
    for (const c of cases) {
      const { deps, store } = baseDeps({ budget: { ...DEFAULT_BUDGET, maxAttemptsPerUnit: 1 } });
      (deps.spawn as any).mockImplementation(async (o: any) => {
        if (o.tools.includes("write")) return okSpawn("made it");
        if (o.role === "checker") return okSpawn(c.checkerPass ? PASS : FAIL("spec"));
        return okSpawn(c.reviewerPass ? PASS : FAIL("standards"));
      });
      const u = unit();
      store.upsertWorkUnit(u);
      const out = await runUnit(project, u, deps);
      expect(out.status).toBe(c.expectApproved ? "approved" : "failed");
      store.close();
    }
  });

  it("ONE overCap check gates the pair; recordRun order is checker then reviewer (reviewer keeps higher seq)", async () => {
    const { deps, store } = baseDeps({ budget: { ...DEFAULT_BUDGET, maxTokensPerUnit: 1000 } });
    (deps.spawn as any).mockImplementation(async (o: any) => {
      if (o.tools.includes("write")) return okSpawn("made it", { tokensIn: 10, tokensOut: 10 });
      // reviewer resolves first even though it's recorded second.
      if (o.role === "reviewer") return okSpawn(PASS, { tokensIn: 5, tokensOut: 5 });
      await new Promise((r) => setTimeout(r, 5));
      return okSpawn(PASS, { tokensIn: 5, tokensOut: 5 });
    });
    const u = unit();
    store.upsertWorkUnit(u);
    const out = await runUnit(project, u, deps);
    expect(out.status).toBe("approved");

    const runs = store.runsForUnit(u.id);
    const checkerIdx = runs.findIndex((r) => r.role === "checker");
    const reviewerIdx = runs.findIndex((r) => r.role === "reviewer");
    expect(checkerIdx).toBeLessThan(reviewerIdx); // checker recorded first → reviewer keeps the higher seq
  });
});
