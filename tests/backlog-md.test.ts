import { describe, it, expect } from "vitest";
import { parseBacklog } from "../src/store/backlog-md.js";
import { slugFromIssueFilename } from "../src/store/slug.js";

const md = `# Backlog

## add-foo-guard
title: Add foo guard
Validate foo input before processing.
Reject empty foo.

## fix-bar
Fix bar off-by-one.
`;

const prefixedMd = `# Backlog

## 06-sync-status
Sync the status line.

## 3d-rendering
Render in 3d.
`;

describe("parseBacklog", () => {
  it("returns one unit per ## heading", () => {
    expect(parseBacklog(md, "p").map((u) => u.slug)).toEqual(["add-foo-guard", "fix-bar"]);
  });

  it("captures title and spec body", () => {
    const u = parseBacklog(md, "p")[0];
    expect(u.title).toBe("Add foo guard");
    expect(u.spec).toMatch(/Validate foo input/);
    expect(u.spec).toMatch(/Reject empty foo/);
  });

  it("defaults title to slug when no title line", () => {
    expect(parseBacklog(md, "p")[1].title).toBe("fix-bar");
  });

  it("sets projectId and pending status", () => {
    const u = parseBacklog(md, "proj")[0];
    expect(u.projectId).toBe("proj");
    expect(u.status).toBe("pending");
  });

  it("strips a bounded ordering prefix from a heading, same rule as issue filenames", () => {
    expect(parseBacklog(prefixedMd, "p").map((u) => u.slug)).toEqual(["sync-status", "3d-rendering"]);
  });

  it("agrees with slugFromIssueFilename so a backlog heading and an issue filename for the same logical unit map to the same id", () => {
    const backlogUnit = parseBacklog(prefixedMd, "issues")[0];
    expect(backlogUnit.id).toBe(`issues:${slugFromIssueFilename("06-sync-status.md")}`);
  });
});
