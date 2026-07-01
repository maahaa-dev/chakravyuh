import { describe, it, expect } from "vitest";
import { newWorkUnit, withStatus, DEFAULT_BUDGET } from "../src/domain.js";

describe("domain", () => {
  it("newWorkUnit fills defaults and is immutable", () => {
    const u = newWorkUnit({ projectId: "p", slug: "add-foo", title: "Add foo", spec: "do foo" });
    expect(u.status).toBe("pending");
    expect(u.attempt).toBe(0);
    expect(u.maxAttempts).toBe(3);
    // id is deterministic from project+slug so re-parsing the backlog maps to the same store row
    expect(u.id).toBe("p:add-foo");
  });

  it("newWorkUnit honors an explicit id over the deterministic default", () => {
    const u = newWorkUnit({ id: "custom-1", projectId: "p", slug: "add-foo", title: "t", spec: "x" });
    expect(u.id).toBe("custom-1");
  });

  it("withStatus returns a new object, leaves original unchanged", () => {
    const u = newWorkUnit({ projectId: "p", slug: "s", title: "t", spec: "x" });
    const u2 = withStatus(u, "building", 1);
    expect(u2.status).toBe("building");
    expect(u2.attempt).toBe(1);
    expect(u.status).toBe("pending"); // original untouched
    expect(u2).not.toBe(u);
  });

  it("DEFAULT_BUDGET bounds on attempts and time", () => {
    expect(DEFAULT_BUDGET.maxAttemptsPerUnit).toBe(3);
    expect(DEFAULT_BUDGET.idleTimeoutMs).toBeGreaterThan(0);
    expect(DEFAULT_BUDGET.hardTimeoutMs).toBeGreaterThan(DEFAULT_BUDGET.idleTimeoutMs);
  });
});
