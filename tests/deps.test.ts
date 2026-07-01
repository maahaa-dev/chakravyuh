import { describe, it, expect } from "vitest";
import { parseDeps, drainOrder, isBlockedByFailedDep, DrainOrderError } from "../src/deps.js";
import type { WorkUnit, WorkUnitStatus } from "../src/domain.js";

function unit(overrides: Partial<WorkUnit>): WorkUnit {
  return {
    id: `p:${overrides.slug ?? "slug"}`, projectId: "p", slug: "slug", title: "Title", spec: "do it",
    status: "pending", attempt: 0, maxAttempts: 3,
    createdAt: "", updatedAt: "",
    ...overrides,
  } as WorkUnit;
}

describe("parseDeps", () => {
  it("returns [] when no Blocked by/deps line is present", () => {
    expect(parseDeps("just a plain spec")).toEqual([]);
  });

  it("parses a 'Blocked by: a, b' line", () => {
    expect(parseDeps("do the thing\nBlocked by: a, b\nmore text")).toEqual(["a", "b"]);
  });

  it("parses a 'deps: [a, b]' line", () => {
    expect(parseDeps("do the thing\ndeps: [a, b]")).toEqual(["a", "b"]);
  });

  it("trims whitespace and drops empty entries", () => {
    expect(parseDeps("Blocked by:  a ,  b ,")).toEqual(["a", "b"]);
  });
});

describe("drainOrder", () => {
  it("orders a linear chain so each dependency runs before its dependent", () => {
    const a = unit({ slug: "a", spec: "first" });
    const b = unit({ slug: "b", spec: "Blocked by: a" });
    const c = unit({ slug: "c", spec: "Blocked by: b" });
    // deliberately out of order
    const ordered = drainOrder([c, a, b]).map((u) => u.slug);
    expect(ordered).toEqual(["a", "b", "c"]);
  });

  it("preserves backlog order when there is no dependency constraint", () => {
    const a = unit({ slug: "a" });
    const b = unit({ slug: "b" });
    expect(drainOrder([a, b]).map((u) => u.slug)).toEqual(["a", "b"]);
    expect(drainOrder([b, a]).map((u) => u.slug)).toEqual(["b", "a"]);
  });

  it("ignores a dependency slug that is not in this backlog", () => {
    const a = unit({ slug: "a", spec: "Blocked by: nowhere" });
    expect(drainOrder([a]).map((u) => u.slug)).toEqual(["a"]);
  });

  it("throws a stable DrainOrderError on a cycle instead of hanging", () => {
    const a = unit({ slug: "a", spec: "Blocked by: b" });
    const b = unit({ slug: "b", spec: "Blocked by: a" });
    expect(() => drainOrder([a, b])).toThrow(DrainOrderError);
  });

  it("throws on a self-cycle", () => {
    const a = unit({ slug: "a", spec: "Blocked by: a" });
    expect(() => drainOrder([a])).toThrow(DrainOrderError);
  });
});

describe("isBlockedByFailedDep", () => {
  it("is false when the unit has no deps", () => {
    const a = unit({ slug: "a" });
    expect(isBlockedByFailedDep(a, new Map())).toBe(false);
  });

  it("is true when a declared dep ended failed", () => {
    const b = unit({ slug: "b", spec: "Blocked by: a" });
    const statuses = new Map<string, WorkUnitStatus>([["a", "failed"]]);
    expect(isBlockedByFailedDep(b, statuses)).toBe(true);
  });

  it("is false when the dep succeeded", () => {
    const b = unit({ slug: "b", spec: "Blocked by: a" });
    const statuses = new Map<string, WorkUnitStatus>([["a", "approved"]]);
    expect(isBlockedByFailedDep(b, statuses)).toBe(false);
  });

  it("blocks transitively: a dependent of a blocked unit is itself blocked", () => {
    const a = unit({ slug: "a", spec: "first" });
    const b = unit({ slug: "b", spec: "Blocked by: a" });
    const c = unit({ slug: "c", spec: "Blocked by: b" });

    const statuses = new Map<string, WorkUnitStatus>();
    for (const u of drainOrder([a, b, c])) {
      if (isBlockedByFailedDep(u, statuses)) {
        statuses.set(u.slug, "blocked");
        continue;
      }
      statuses.set(u.slug, u.slug === "a" ? "failed" : "approved");
    }

    expect(statuses.get("a")).toBe("failed");
    expect(statuses.get("b")).toBe("blocked");
    expect(statuses.get("c")).toBe("blocked");
  });
});
