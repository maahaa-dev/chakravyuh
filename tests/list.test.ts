import { describe, it, expect } from "vitest";
import { listUnitsText } from "../src/list.js";
import type { WorkUnit } from "../src/domain.js";

function unit(overrides: Partial<WorkUnit>): WorkUnit {
  return {
    id: "p:slug", projectId: "p", slug: "slug", title: "Title", spec: "do it",
    status: "pending", attempt: 0,
    ...overrides,
  } as WorkUnit;
}

describe("listUnitsText", () => {
  it("renders a unit with a title as slug<TAB>title", () => {
    const out = listUnitsText([unit({ slug: "fix-bug", title: "Fix the bug" })]);
    expect(out).toBe("fix-bug\tFix the bug");
  });

  it("falls back to the slug when title is empty", () => {
    const out = listUnitsText([unit({ slug: "fix-bug", title: "" })]);
    expect(out).toBe("fix-bug\tfix-bug");
  });

  it("renders multiple units, one per line, in input order", () => {
    const out = listUnitsText([
      unit({ slug: "a", title: "A title" }),
      unit({ slug: "b", title: "" }),
      unit({ slug: "c", title: "C title" }),
    ]);
    expect(out).toBe("a\tA title\nb\tb\nc\tC title");
  });
});
