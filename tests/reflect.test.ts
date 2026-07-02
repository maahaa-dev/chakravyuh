import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, WorkUnit } from "../src/domain.js";
import type { PiSpawnOpts, PiSpawnResult } from "../src/pi.js";
import { piLogPath } from "../src/pi-log.js";
import { buildReflectionInput, runReflect } from "../src/reflect.js";

function unit(overrides: Partial<WorkUnit> = {}): WorkUnit {
  return {
    id: "proj:fix-add", projectId: "proj", slug: "fix-add", title: "Fix add",
    spec: "add two numbers", status: "approved", attempt: 2, maxAttempts: 3,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "r1", workUnitId: "proj:fix-add", role: "maker", attempt: 1,
    provider: "anthropic", model: "claude", thinking: "medium",
    startedAt: "2026-01-01T00:00:00.000Z", tokensIn: 100, tokensOut: 50,
    ...overrides,
  };
}

describe("buildReflectionInput", () => {
  it("derives outcome and attemptsToApprove from the unit's terminal status/attempt", () => {
    const u = unit({ status: "failed", attempt: 3 });
    const out = buildReflectionInput([u], [], "/logs");
    expect(out.units).toHaveLength(1);
    expect(out.units[0].outcome).toBe("failed");
    expect(out.units[0].attemptsToApprove).toBe(3);
    expect(out.units[0].unitId).toBe(u.id);
    expect(out.units[0].slug).toBe(u.slug);
  });

  it("sums tokensIn + tokensOut across all of a unit's runs", () => {
    const u = unit();
    const runs = [
      run({ id: "r1", attempt: 1, role: "maker", tokensIn: 100, tokensOut: 50 }),
      run({ id: "r2", attempt: 1, role: "checker", tokensIn: 10, tokensOut: 5 }),
      run({ id: "r3", attempt: 2, role: "maker", tokensIn: 200, tokensOut: 20 }),
    ];
    const out = buildReflectionInput([u], runs, "/logs");
    expect(out.units[0].tokensToApprove).toBe(100 + 50 + 10 + 5 + 200 + 20);
  });

  it("only sums runs belonging to that unit, ignoring other units' runs", () => {
    const u = unit();
    const runs = [
      run({ id: "r1", workUnitId: u.id, tokensIn: 100, tokensOut: 50 }),
      run({ id: "r2", workUnitId: "proj:other", tokensIn: 9999, tokensOut: 9999 }),
    ];
    const out = buildReflectionInput([u], runs, "/logs");
    expect(out.units[0].tokensToApprove).toBe(150);
  });

  it("extracts rejectReasons from verdict.blockers, labelling checker as Spec and reviewer as Standards", () => {
    const u = unit();
    const runs = [
      run({
        id: "r1", role: "checker", attempt: 1,
        verdict: { pass: false, summary: "spec fail", blockers: ["missing test", "wrong signature"], evidence: [] },
      }),
      run({
        id: "r2", role: "reviewer", attempt: 1,
        verdict: { pass: false, summary: "standards fail", blockers: ["no docstring"], evidence: [] },
      }),
      // an attempt-2 checker run repeating one blocker from attempt 1
      run({
        id: "r3", role: "checker", attempt: 2,
        verdict: { pass: false, summary: "still failing", blockers: ["missing test"], evidence: [] },
      }),
      // maker runs carry no verdict axis and should not contribute reject reasons
      run({ id: "r4", role: "maker", attempt: 1, verdict: undefined }),
    ];
    const out = buildReflectionInput([u], runs, "/logs");
    expect(out.units[0].rejectReasons).toEqual([
      { axis: "Spec", attempt: 1, blocker: "missing test" },
      { axis: "Spec", attempt: 1, blocker: "wrong signature" },
      { axis: "Standards", attempt: 1, blocker: "no docstring" },
      { axis: "Spec", attempt: 2, blocker: "missing test" },
    ]);
  });

  it("omits reject reasons for a run with no verdict at all", () => {
    const u = unit();
    const runs = [run({ id: "r1", role: "checker", attempt: 1, verdict: undefined })];
    const out = buildReflectionInput([u], runs, "/logs");
    expect(out.units[0].rejectReasons).toEqual([]);
  });

  it("pairs each run with its per-run stdout log path via piLogPath's convention", () => {
    const u = unit({ slug: "fix-add" });
    const runs = [
      run({ id: "r1", role: "maker", attempt: 1 }),
      run({ id: "r2", role: "checker", attempt: 1 }),
      run({ id: "r3", role: "maker", attempt: 2 }),
    ];
    const out = buildReflectionInput([u], runs, "/logs");
    expect(out.units[0].logPaths).toEqual([
      { runId: "r1", role: "maker", attempt: 1, path: piLogPath("/logs", "fix-add", "maker", 1) },
      { runId: "r2", role: "checker", attempt: 1, path: piLogPath("/logs", "fix-add", "checker", 1) },
      { runId: "r3", role: "maker", attempt: 2, path: piLogPath("/logs", "fix-add", "maker", 2) },
    ]);
  });

  it("never mutates the input units or runs arrays", () => {
    const units = [unit()];
    const runs = [run()];
    const unitsCopy = JSON.parse(JSON.stringify(units));
    const runsCopy = JSON.parse(JSON.stringify(runs));
    buildReflectionInput(units, runs, "/logs");
    expect(units).toEqual(unitsCopy);
    expect(runs).toEqual(runsCopy);
  });

  it("returns an empty digest for no units", () => {
    expect(buildReflectionInput([], [], "/logs")).toEqual({ units: [] });
  });
});

describe("runReflect", () => {
  let outputDir: string;

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  function fakeSpawn(text: string): (o: PiSpawnOpts) => Promise<PiSpawnResult> {
    return async (): Promise<PiSpawnResult> =>
      ({ sessionId: "s", stopReason: "stop", tokensIn: 1, tokensOut: 1, text, exitReason: "exit:0" });
  }

  const opts = {
    provider: "anthropic", model: "haiku", thinking: "low",
    idleTimeoutMs: 1000, hardTimeoutMs: 2000,
  };

  it("writes the reflector's final text to a markdown file under the reflections dir", async () => {
    const parent = mkdtempSync(join(tmpdir(), "reflect-"));
    outputDir = join(parent, "reflections"); // does not exist yet — runReflect must create it
    const digest = buildReflectionInput([], [], "/logs");

    const path = await runReflect(fakeSpawn("## Findings\n\nNo issues found."), digest, outputDir, opts);

    expect(existsSync(outputDir)).toBe(true);
    expect(path.startsWith(outputDir)).toBe(true);
    expect(path.endsWith(".md")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("## Findings\n\nNo issues found.");
    // the ISO-timestamp filename convention
    const filename = path.slice(outputDir.length + 1);
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-?\d{2}.*\.md$|^.+Z\.md$/);
  });

  it("writes exactly one file, the only artifact this command produces", async () => {
    const parent = mkdtempSync(join(tmpdir(), "reflect-"));
    outputDir = join(parent, "reflections");
    const digest = buildReflectionInput([], [], "/logs");

    await runReflect(fakeSpawn("proposal body"), digest, outputDir, opts);

    expect(readdirSync(outputDir)).toHaveLength(1);
  });

  it("spawns exactly once, with read-only tools and no worktree/cwd override", async () => {
    const parent = mkdtempSync(join(tmpdir(), "reflect-"));
    outputDir = join(parent, "reflections");
    const digest = buildReflectionInput([], [], "/logs");
    const calls: PiSpawnOpts[] = [];
    const spy = async (o: PiSpawnOpts): Promise<PiSpawnResult> => {
      calls.push(o);
      return { sessionId: "s", stopReason: "stop", tokensIn: 1, tokensOut: 1, text: "ok", exitReason: "exit:0" };
    };

    await runReflect(spy, digest, outputDir, opts);

    expect(calls).toHaveLength(1);
    expect(calls[0].tools).toBe("read,grep,find,ls");
    expect(calls[0].sandbox).toBeUndefined();
  });

  it("never creates a worktree directory or touches git", async () => {
    const parent = mkdtempSync(join(tmpdir(), "reflect-"));
    outputDir = join(parent, "reflections");
    const digest = buildReflectionInput([], [], "/logs");

    await runReflect(fakeSpawn("proposal body"), digest, outputDir, opts);

    // nothing beyond the reflections dir and its one file was created under parent
    expect(readdirSync(parent)).toEqual(["reflections"]);
    expect(existsSync(join(parent, ".git"))).toBe(false);
  });
});
