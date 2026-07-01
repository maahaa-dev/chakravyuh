import { describe, it, expect } from "vitest";
import { slugFromIssueFilename, stripOrderingPrefix } from "../src/store/slug.js";

describe("slugFromIssueFilename", () => {
  it("strips a bounded NN- ordering prefix and trailing .md", () => {
    expect(slugFromIssueFilename("06-sync-status.md")).toBe("sync-status");
  });

  it("leaves a filename with no numeric prefix unchanged (besides .md)", () => {
    expect(slugFromIssueFilename("sync-status.md")).toBe("sync-status");
  });

  it("does NOT strip digits that aren't a bounded ordering prefix (no trailing hyphen split)", () => {
    // "3d-rendering" starts with a digit followed by a letter, not `<digits>-`, so it must survive whole.
    expect(slugFromIssueFilename("3d-rendering.md")).toBe("3d-rendering");
  });

  it("strips a 3-digit ordering prefix", () => {
    expect(slugFromIssueFilename("123-a-b.md")).toBe("a-b");
  });

  it("leaves a 4+ digit run unchanged (outside the bounded counter shape)", () => {
    expect(slugFromIssueFilename("1234-foo.md")).toBe("1234-foo");
  });

  it("never strips down to an empty remainder", () => {
    expect(slugFromIssueFilename("123-.md")).toBe("123-");
  });
});

describe("stripOrderingPrefix", () => {
  it("is the single rule both intake paths route through", () => {
    expect(stripOrderingPrefix("06-sync-status")).toBe("sync-status");
    expect(stripOrderingPrefix("3d-rendering")).toBe("3d-rendering");
  });
});
