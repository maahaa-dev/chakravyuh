import { describe, it, expect } from "vitest";
import { scheduleStep } from "../src/schedule.js";
import { drainOrder } from "../src/deps.js";
import type { WorkUnit, WorkUnitStatus } from "../src/domain.js";

function unit(overrides: Partial<WorkUnit>): WorkUnit {
  return {
    id: `p:${overrides.slug ?? "slug"}`, projectId: "p", slug: "slug", title: "Title", spec: "do it",
    status: "pending", attempt: 0, maxAttempts: 3,
    createdAt: "", updatedAt: "",
    ...overrides,
  } as WorkUnit;
}

describe("scheduleStep", () => {
  it("cap:1 starts exactly one unit per tick, matching drainOrder's sequence", () => {
    const a = unit({ slug: "a" });
    const b = unit({ slug: "b" });
    const c = unit({ slug: "c" });
    const ordered = drainOrder([a, b, c]);

    const statuses = new Map<string, WorkUnitStatus>();
    const inFlight = new Set<string>();

    // tick 1: nothing settled or in flight -> exactly one start, in order
    let step = scheduleStep(ordered, statuses, inFlight, 1);
    expect(step.start.map((u) => u.slug)).toEqual(["a"]);
    expect(step.block).toEqual([]);

    // a is now running
    inFlight.add("a");
    step = scheduleStep(ordered, statuses, inFlight, 1);
    expect(step.start).toEqual([]);

    // a finishes
    inFlight.delete("a");
    statuses.set("a", "approved");
    step = scheduleStep(ordered, statuses, inFlight, 1);
    expect(step.start.map((u) => u.slug)).toEqual(["b"]);

    inFlight.add("b");
    inFlight.delete("a");
    statuses.set("b", "approved");
    inFlight.delete("b");
    step = scheduleStep(ordered, statuses, inFlight, 1);
    expect(step.start.map((u) => u.slug)).toEqual(["c"]);
  });

  it("4 independent units, cap:2 -> first tick starts 2, block empty, then the next 2", () => {
    const units = ["a", "b", "c", "d"].map((slug) => unit({ slug }));
    const ordered = drainOrder(units);
    const statuses = new Map<string, WorkUnitStatus>();
    const inFlight = new Set<string>();

    let step = scheduleStep(ordered, statuses, inFlight, 2);
    expect(step.start.map((u) => u.slug)).toEqual(["a", "b"]);
    expect(step.block).toEqual([]);

    for (const u of step.start) inFlight.add(u.slug);
    // a and b settle
    for (const slug of ["a", "b"]) {
      inFlight.delete(slug);
      statuses.set(slug, "approved");
    }

    step = scheduleStep(ordered, statuses, inFlight, 2);
    expect(step.start.map((u) => u.slug)).toEqual(["c", "d"]);
  });

  it("chain A->B->C, cap:3 -> tick 1 starts only A; B neither started nor blocked while A in flight", () => {
    const a = unit({ slug: "a" });
    const b = unit({ slug: "b", spec: "Blocked by: a" });
    const c = unit({ slug: "c", spec: "Blocked by: b" });
    const ordered = drainOrder([a, b, c]);

    const statuses = new Map<string, WorkUnitStatus>();
    const inFlight = new Set<string>();

    let step = scheduleStep(ordered, statuses, inFlight, 3);
    expect(step.start.map((u) => u.slug)).toEqual(["a"]);
    expect(step.block).toEqual([]);

    inFlight.add("a");
    step = scheduleStep(ordered, statuses, inFlight, 3);
    expect(step.start).toEqual([]);
    expect(step.block).toEqual([]); // b is waiting, not blocked, not started

    inFlight.delete("a");
    statuses.set("a", "approved");
    step = scheduleStep(ordered, statuses, inFlight, 3);
    expect(step.start.map((u) => u.slug)).toEqual(["b"]);
  });

  it("a failed dep blocks its dependent, and blocks transitively across ticks", () => {
    const a = unit({ slug: "a" });
    const b = unit({ slug: "b", spec: "Blocked by: a" });
    const c = unit({ slug: "c", spec: "Blocked by: b" });
    const ordered = drainOrder([a, b, c]);

    const statuses = new Map<string, WorkUnitStatus>([["a", "failed"]]);
    const inFlight = new Set<string>();

    const step = scheduleStep(ordered, statuses, inFlight, 3);
    expect(step.start).toEqual([]);
    expect(step.block.map((u) => u.slug)).toEqual(["b", "c"]);
  });

  it("an in-flight dep makes the dependent wait: absent from both start and block", () => {
    const a = unit({ slug: "a" });
    const b = unit({ slug: "b", spec: "Blocked by: a" });
    const ordered = drainOrder([a, b]);

    const statuses = new Map<string, WorkUnitStatus>();
    const inFlight = new Set<string>(["a"]);

    const step = scheduleStep(ordered, statuses, inFlight, 3);
    expect(step.start).toEqual([]);
    expect(step.block).toEqual([]);
  });
});
