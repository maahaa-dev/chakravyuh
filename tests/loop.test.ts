import { describe, it, expect, vi } from "vitest";
import { runUnit } from "../src/loop.js";
import { SqliteStore } from "../src/store/sqlite-store.js";
import { newWorkUnit, DEFAULT_BUDGET, type Project } from "../src/domain.js";
import type { PiSpawnResult } from "../src/pi.js";

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
      // root is clean (no leak); the worktree is dirty (the maker made changes). The loop calls
      // rootIsClean(project.root) for the leak guard and rootIsClean(worktree) for the empty-diff guard.
      rootIsClean: vi.fn((dir: string) => dir === project.root),
      commitAll: vi.fn(),
      stopRequested: () => false,
      roles, budget: DEFAULT_BUDGET, ...over,
    },
    store,
  };
}

const okSpawn = (text: string): PiSpawnResult =>
  ({ sessionId: "s", stopReason: "stop", tokensIn: 1, tokensOut: 1, text, exitReason: "exit:0" });
const PASS = 'ok\n```json\n{"pass":true,"summary":"ok","blockers":[]}\n```';
const FAIL = 'no\n```json\n{"pass":false,"summary":"bad","blockers":["fix it"]}\n```';

describe("runUnit", () => {
  it("happy path: maker→checker→reviewer pass → approved + commit", async () => {
    const { deps, store } = baseDeps();
    (deps.spawn as any).mockImplementation(async (o: any) =>
      okSpawn(o.tools.includes("write") ? "made it" : PASS));
    const unit = newWorkUnit({ id: "u1", projectId: "p", slug: "s", title: "t", spec: "do" });
    store.upsertWorkUnit(unit);

    const out = await runUnit(project, unit, deps);
    expect(out.status).toBe("approved");
    expect(deps.commitAll).toHaveBeenCalledOnce();
    // checker + reviewer were invoked read-only
    const calls = (deps.spawn as any).mock.calls.map((c: any[]) => c[0].tools);
    expect(calls).toContain("read,grep,find,ls");
    // Fix 4: reviewer used a different provider (openai)
    const providers = (deps.spawn as any).mock.calls.map((c: any[]) => c[0].provider);
    expect(providers).toContain("openai");
  });

  it("checker fail then pass → bounded retry, then approved", async () => {
    const { deps, store } = baseDeps();
    let checkerCalls = 0;
    (deps.spawn as any).mockImplementation(async (o: any) => {
      if (o.tools.includes("write")) return okSpawn("made it");
      if (o.role === "checker") return okSpawn(checkerCalls++ === 0 ? FAIL : PASS);
      return okSpawn(PASS);
    });
    const unit = newWorkUnit({ id: "u1", projectId: "p", slug: "s", title: "t", spec: "do" });
    store.upsertWorkUnit(unit);
    const out = await runUnit(project, unit, deps);
    expect(out.status).toBe("approved");
    expect(out.attempt).toBe(2);
  });

  it("exhausts maxAttempts → failed, no commit", async () => {
    const { deps, store } = baseDeps();
    (deps.spawn as any).mockImplementation(async (o: any) =>
      okSpawn(o.tools.includes("write") ? "made it" : FAIL));
    const unit = newWorkUnit({ id: "u1", projectId: "p", slug: "s", title: "t", spec: "do" });
    store.upsertWorkUnit(unit);
    const out = await runUnit(project, unit, deps);
    expect(out.status).toBe("failed");
    expect(deps.commitAll).not.toHaveBeenCalled();
  });

  it("zero maxAttempts → failed, spawn not called", async () => {
    const { deps, store } = baseDeps({
      budget: { maxAttemptsPerUnit: 0, idleTimeoutMs: 5000, hardTimeoutMs: 10000 },
    });
    const unit = newWorkUnit({ id: "u1", projectId: "p", slug: "s", title: "t", spec: "do" });
    store.upsertWorkUnit(unit);
    const out = await runUnit(project, unit, deps);
    expect(out.status).toBe("failed");
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("gate-after red + model PASS → never approves", async () => {
    // Verifies gate-after is authoritative: even when the model emits a PASS verdict,
    // a non-zero gate-after exit code prevents approval. The maker DOES run (worktree
    // was created); it is the post-maker gate that blocks the unit, not a pre-gate check.
    const { deps, store } = baseDeps({
      runHealth: vi.fn(() => ({ command: "x", exitCode: 1, durationMs: 1 })),
    });
    (deps.spawn as any).mockImplementation(async () => okSpawn(PASS));
    const unit = newWorkUnit({ id: "u1", projectId: "p", slug: "s", title: "t", spec: "do" });
    store.upsertWorkUnit(unit);
    const out = await runUnit(project, unit, deps);
    expect(out.status).toBe("failed");
    expect(deps.commitAll).not.toHaveBeenCalled();
    expect(deps.spawn).toHaveBeenCalled(); // maker DID run; approval blocked by red gate-after
  });

  it("stopRequested halts before maker", async () => {
    const { deps, store } = baseDeps({ stopRequested: () => true });
    const unit = newWorkUnit({ id: "u1", projectId: "p", slug: "s", title: "t", spec: "do" });
    store.upsertWorkUnit(unit);
    const out = await runUnit(project, unit, deps);
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(out.status).toBe("blocked");
  });

  it("root dirty after maker (rootIsClean false) → failed, no commit", async () => {
    const { deps, store } = baseDeps({ rootIsClean: vi.fn(() => false) });
    (deps.spawn as any).mockImplementation(async () => okSpawn("made it"));
    const unit = newWorkUnit({ id: "u1", projectId: "p", slug: "s", title: "t", spec: "do" });
    store.upsertWorkUnit(unit);
    const out = await runUnit(project, unit, deps);
    expect(out.status).toBe("failed");
  });

  it("stop after maker → blocked before checker", async () => {
    let spawns = 0;
    const { deps, store } = baseDeps({ stopRequested: () => spawns >= 1 });
    (deps.spawn as any).mockImplementation(async (o: any) => {
      spawns++;
      return okSpawn(o.tools.includes("write") ? "made it" : PASS);
    });
    const unit = newWorkUnit({ id: "u1", projectId: "p", slug: "s", title: "t", spec: "do" });
    store.upsertWorkUnit(unit);
    const out = await runUnit(project, unit, deps);
    expect(out.status).toBe("blocked");
    expect(spawns).toBe(1); // only maker ran
  });

  it("stop after gate passes → blocked before the checker+reviewer pair spawns", async () => {
    // The checker and reviewer now spawn together (Promise.all), so the only remaining
    // stop-checkpoint between the maker and that pair is right after the gate passes.
    let spawns = 0;
    const { deps, store } = baseDeps({ stopRequested: () => spawns >= 1 });
    (deps.spawn as any).mockImplementation(async (o: any) => {
      spawns++;
      return okSpawn(o.tools.includes("write") ? "made it" : PASS);
    });
    const unit = newWorkUnit({ id: "u1", projectId: "p", slug: "s", title: "t", spec: "do" });
    store.upsertWorkUnit(unit);
    const out = await runUnit(project, unit, deps);
    expect(out.status).toBe("blocked");
    expect(spawns).toBe(1); // only the maker ran; the gate itself doesn't spawn Pi
  });

  it("approved → removes worktree but KEEPS the branch (human merges it)", async () => {
    const { deps, store } = baseDeps();
    (deps.spawn as any).mockImplementation(async (o: any) =>
      okSpawn(o.tools.includes("write") ? "made it" : PASS));
    const unit = newWorkUnit({ id: "u1", projectId: "p", slug: "s", title: "t", spec: "do" });
    store.upsertWorkUnit(unit);
    const out = await runUnit(project, unit, deps);
    expect(out.status).toBe("approved");
    expect(deps.removeWorktree).toHaveBeenCalledWith(project, "/tmp/wt/s");
    expect(deps.deleteBranch).not.toHaveBeenCalled();
  });

  it("failed → removes worktree AND deletes the throwaway branch", async () => {
    const { deps, store } = baseDeps();
    (deps.spawn as any).mockImplementation(async (o: any) =>
      okSpawn(o.tools.includes("write") ? "made it" : FAIL));
    const unit = newWorkUnit({ id: "u1", projectId: "p", slug: "s", title: "t", spec: "do" });
    store.upsertWorkUnit(unit);
    const out = await runUnit(project, unit, deps);
    expect(out.status).toBe("failed");
    expect(deps.removeWorktree).toHaveBeenCalledWith(project, "/tmp/wt/s");
    expect(deps.deleteBranch).toHaveBeenCalledWith("/tmp/x", "chakravyuh/s");
  });

  it("exceeding maxTokensPerUnit fails the unit (runaway backstop)", async () => {
    const { deps, store } = baseDeps({
      budget: { ...DEFAULT_BUDGET, maxTokensPerUnit: 5 },
    });
    // maker alone returns 10 tokens > cap of 5 → fail right after the maker run
    (deps.spawn as any).mockImplementation(async () =>
      ({ sessionId: "s", stopReason: "stop", tokensIn: 4, tokensOut: 6, text: "made it", exitReason: "exit:0" }));
    const unit = newWorkUnit({ id: "u1", projectId: "p", slug: "s", title: "t", spec: "do" });
    store.upsertWorkUnit(unit);
    const out = await runUnit(project, unit, deps);
    expect(out.status).toBe("failed");
    expect(deps.commitAll).not.toHaveBeenCalled();
    // only the maker ran before the budget tripped
    expect((deps.spawn as any).mock.calls.length).toBe(1);
  });

  it("crossing the cap on the reviewer (last spawn) still commits the approved work", async () => {
    // cap=100; maker 30 + checker 30 = 60 (<cap), reviewer 60 pushes to 120 (>cap) but is the
    // final spawn — the over-cap check must not discard work that already passed review.
    const tok = (n: number) => ({ tokensIn: 0, tokensOut: n });
    const { deps, store } = baseDeps({ budget: { ...DEFAULT_BUDGET, maxTokensPerUnit: 100 } });
    (deps.spawn as any).mockImplementation(async (o: any) => {
      const n = o.role === "maker" ? 30 : o.role === "checker" ? 30 : 60;
      return { sessionId: "s", stopReason: "stop", text: o.tools.includes("write") ? "made" : PASS, exitReason: "exit:0", ...tok(n) };
    });
    const unit = newWorkUnit({ id: "u1", projectId: "p", slug: "s", title: "t", spec: "do" });
    store.upsertWorkUnit(unit);
    const out = await runUnit(project, unit, deps);
    expect(out.status).toBe("approved");
    expect(deps.commitAll).toHaveBeenCalledOnce();
  });

  it("cumulative feedback: attempt-2 maker prompt contains attempt-1 blockers labelled by number", async () => {
    // Scenario: attempt 1 → checker rejects with "fix it"; attempt 2 must see that failure
    // in its maker prompt, labelled with the attempt number it came from.
    const { deps, store } = baseDeps();
    let makerCalls = 0;
    let attempt2Prompt: string | undefined;
    (deps.spawn as any).mockImplementation(async (o: any) => {
      if (o.role === "maker") {
        makerCalls++;
        if (makerCalls === 2) attempt2Prompt = o.prompt;
        return okSpawn("made it");
      }
      // checker fails on attempt 1, passes on attempt 2
      if (o.role === "checker") return okSpawn(makerCalls === 1 ? FAIL : PASS);
      return okSpawn(PASS); // reviewer always passes
    });
    const unit = newWorkUnit({ id: "u1", projectId: "p", slug: "s", title: "t", spec: "do" });
    store.upsertWorkUnit(unit);
    const out = await runUnit(project, unit, deps);
    expect(out.status).toBe("approved");
    expect(attempt2Prompt).toBeDefined();
    // Must carry ALL prior-attempt blockers, labelled — not just overwrite with the latest.
    expect(attempt2Prompt).toContain("Attempt 1 blockers");
    expect(attempt2Prompt).toContain("fix it"); // the original blocker text from FAIL
  });

  it("empty maker diff (clean worktree) retries instead of crashing on an empty commit", async () => {
    // worktree reports clean (maker changed nothing) even though all roles pass → must NOT commit.
    const { deps, store } = baseDeps({ rootIsClean: vi.fn(() => true) });
    (deps.spawn as any).mockImplementation(async (o: any) =>
      okSpawn(o.tools.includes("write") ? "made nothing" : PASS));
    const unit = newWorkUnit({ id: "u1", projectId: "p", slug: "s", title: "t", spec: "do" });
    store.upsertWorkUnit(unit);
    const out = await runUnit(project, unit, deps);
    expect(out.status).toBe("failed"); // exhausts attempts via the no-changes retry
    expect(deps.commitAll).not.toHaveBeenCalled();
  });

  it("blocked (STOP/PAUSE) leaves the worktree AND branch intact for resume", async () => {
    let spawns = 0;
    const { deps, store } = baseDeps({ stopRequested: () => spawns >= 1 });
    (deps.spawn as any).mockImplementation(async (o: any) => {
      spawns++;
      return okSpawn(o.tools.includes("write") ? "made it" : PASS);
    });
    const unit = newWorkUnit({ id: "u1", projectId: "p", slug: "s", title: "t", spec: "do" });
    store.upsertWorkUnit(unit);
    const out = await runUnit(project, unit, deps);
    expect(out.status).toBe("blocked");
    expect(deps.removeWorktree).not.toHaveBeenCalled();
    expect(deps.deleteBranch).not.toHaveBeenCalled();
  });
});
