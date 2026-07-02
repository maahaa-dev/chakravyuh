import { describe, it, expect } from "vitest";
import { renderStatus } from "../src/status.js";
import type { Run, WorkUnit } from "../src/domain.js";

function unit(overrides: Partial<WorkUnit>): WorkUnit {
  return {
    id: overrides.id ?? `p:${overrides.slug}`, projectId: "p", slug: "slug", title: "Title",
    spec: "do it", status: "pending", attempt: 0, maxAttempts: 3,
    createdAt: "t", updatedAt: "t",
    ...overrides,
  } as WorkUnit;
}

function run(overrides: Partial<Run>): Run {
  return {
    id: overrides.id ?? crypto.randomUUID(), workUnitId: "p:slug", role: "maker", attempt: 1,
    provider: "anthropic", model: "haiku", thinking: "low", startedAt: "t",
    tokensIn: 1, tokensOut: 2,
    ...overrides,
  } as Run;
}

describe("renderStatus", () => {
  it("renders one line per unit as <slug>: <status> (a<attempt>)", () => {
    const out = renderStatus(
      [
        unit({ slug: "a", status: "pending", attempt: 0 }),
        unit({ slug: "b", status: "approved", attempt: 2 }),
      ],
      [],
      0,
    );
    expect(out).toContain("a: pending (a0)");
    expect(out).toContain("b: approved (a2)");
  });

  it("includes a tally of pending/approved/failed counts", () => {
    const out = renderStatus(
      [
        unit({ slug: "a", status: "pending" }),
        unit({ slug: "b", status: "pending" }),
        unit({ slug: "c", status: "approved" }),
        unit({ slug: "d", status: "failed" }),
      ],
      [],
      0,
    );
    expect(out).toContain("2 pending, 1 approved, 1 failed");
  });

  it("shows the most recent run's role + stop_reason as the active/last line", () => {
    const out = renderStatus(
      [unit({ slug: "a", status: "building", attempt: 1 })],
      [
        run({ workUnitId: "p:a", role: "maker", stopReason: "stop", startedAt: "2024-01-01T00:00:00Z" }),
        run({ workUnitId: "p:a", role: "checker", stopReason: "error", startedAt: "2024-01-02T00:00:00Z" }),
      ],
      0,
    );
    expect(out).toContain("active: checker error");
  });

  it("renders no active line when there are no runs", () => {
    const out = renderStatus([unit({ slug: "a" })], [], 0);
    expect(out).not.toContain("active:");
  });

  it("omits the reflections line when pendingReflections is 0", () => {
    const out = renderStatus([unit({ slug: "a" })], [], 0);
    expect(out).not.toContain("reflections:");
  });

  it("adds a reflections: N pending review line when pendingReflections > 0", () => {
    const out = renderStatus([unit({ slug: "a" })], [], 3);
    expect(out).toContain("reflections: 3 pending review");
  });
});
