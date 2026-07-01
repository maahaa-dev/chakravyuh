import { describe, it, expect } from "vitest";
import { SqliteStore } from "../src/store/sqlite-store.js";
import { newWorkUnit } from "../src/domain.js";
import type { Run } from "../src/domain.js";

function run(over: Partial<Run>): Run {
  return {
    id: over.id ?? crypto.randomUUID(), workUnitId: "u1", role: "maker", attempt: 1,
    provider: "anthropic", model: "haiku", thinking: "low", startedAt: "t",
    tokensIn: 1, tokensOut: 2, ...over,
  };
}

describe("SqliteStore", () => {
  it("upserts and reads a work unit", () => {
    const s = new SqliteStore(":memory:");
    const u = newWorkUnit({ id: "u1", projectId: "p", slug: "s", title: "t", spec: "x" });
    s.upsertWorkUnit(u);
    expect(s.getWorkUnit("u1")?.slug).toBe("s");
    s.close();
  });

  it("setStatus updates status + attempt", () => {
    const s = new SqliteStore(":memory:");
    s.upsertWorkUnit(newWorkUnit({ id: "u1", projectId: "p", slug: "s", title: "t", spec: "x" }));
    s.setStatus("u1", "approved", 2);
    expect(s.getWorkUnit("u1")?.status).toBe("approved");
    expect(s.getWorkUnit("u1")?.attempt).toBe(2);
    s.close();
  });

  it("saveRun appends; runsForUnit returns all in order", () => {
    const s = new SqliteStore(":memory:");
    s.saveRun(run({ id: "r1", role: "maker" }));
    s.saveRun(run({ id: "r2", role: "checker" }));
    const rows = s.runsForUnit("u1");
    expect(rows.map((r) => r.role)).toEqual(["maker", "checker"]);
    s.close();
  });
});
