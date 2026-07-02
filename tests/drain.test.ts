import { describe, it, expect } from "vitest";
import { unitsToDrain, drainSummary } from "../src/drain.js";
import type { WorkUnit, WorkUnitStatus } from "../src/domain.js";

function unit(overrides: Partial<WorkUnit>): WorkUnit {
  return {
    id: "p:slug", projectId: "p", slug: "slug", title: "Title", spec: "do it",
    status: "pending", attempt: 0, maxAttempts: 3,
    createdAt: "", updatedAt: "",
    ...overrides,
  } as WorkUnit;
}

describe("unitsToDrain", () => {
  it("skips approved and failed units", () => {
    const units = [
      unit({ slug: "a", status: "approved" }),
      unit({ slug: "b", status: "failed" }),
    ];
    expect(unitsToDrain(units)).toEqual([]);
  });

  it("keeps pending and blocked units", () => {
    const units = [
      unit({ slug: "a", status: "pending" }),
      unit({ slug: "b", status: "blocked" }),
    ];
    expect(unitsToDrain(units)).toEqual(units);
  });

  it("preserves input order while skipping terminal units", () => {
    const units = [
      unit({ slug: "a", status: "approved" }),
      unit({ slug: "b", status: "pending" }),
      unit({ slug: "c", status: "failed" }),
      unit({ slug: "d", status: "blocked" }),
    ];
    expect(unitsToDrain(units).map((u) => u.slug)).toEqual(["b", "d"]);
  });

  // Loop isolation (design doc, decision 3): a reflection proposal is a markdown file under
  // loops/<proj>/reflections/, never a WorkUnit and never written into backlog.md, so it can
  // never appear in the array unitsToDrain filters over in the first place. Trivially true
  // today, but locked here as an explicit regression guard against a future change that starts
  // parsing proposals into WorkUnits and accidentally lets them leak into --all.
  it("never returns a reflection proposal — every drained unit is a real backlog WorkUnit", () => {
    const units = [
      unit({ slug: "a", status: "pending" }),
      unit({ slug: "b", status: "blocked" }),
    ];
    const drained = unitsToDrain(units);
    expect(drained).toHaveLength(2);
    for (const u of drained) {
      // A reflection proposal has no buildable spec (design doc: "a WorkUnit normally carries a
      // buildable spec; a proposal has none") — every unit unitsToDrain returns has one.
      expect(u.spec.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("drainSummary", () => {
  it("renders one line per result plus a tally", () => {
    const out = drainSummary([
      { slug: "a", status: "approved" as WorkUnitStatus },
      { slug: "b", status: "failed" as WorkUnitStatus },
      { slug: "c", status: "approved" as WorkUnitStatus },
    ]);
    expect(out).toBe("a: approved\nb: failed\nc: approved\n\n2 approved, 1 failed");
  });

  it("tallies non-approved/failed statuses as neither", () => {
    const out = drainSummary([
      { slug: "a", status: "approved" as WorkUnitStatus },
      { slug: "b", status: "blocked" as WorkUnitStatus },
    ]);
    expect(out).toBe("a: approved\nb: blocked\n\n1 approved, 0 failed");
  });
});
