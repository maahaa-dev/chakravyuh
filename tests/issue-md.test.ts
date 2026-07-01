import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIssues } from "../src/store/issue-md.js";
import { slugFromIssueFilename } from "../src/store/slug.js";

let featureDir: string;

beforeAll(() => {
  featureDir = mkdtempSync(join(tmpdir(), "issue-md-"));
  const issuesDir = join(featureDir, "issues");
  mkdirSync(issuesDir);

  writeFileSync(
    join(issuesDir, "01-a.md"),
    `Status: ready-for-agent\n# Title A\n\nBody A line 1.\nBody A line 2.\n`,
  );
  writeFileSync(
    join(issuesDir, "02-b.md"),
    `Status: needs-triage\n# Title B\n\nBody B.\n`,
  );
  writeFileSync(join(issuesDir, "03-c.md"), `# Title C\n\nBody C.\n`);
});

afterAll(() => {
  rmSync(featureDir, { recursive: true, force: true });
});

describe("parseIssues", () => {
  it("returns only the issue with Status: ready-for-agent", () => {
    const units = parseIssues(featureDir);
    expect(units.map((u) => u.slug)).toEqual(["a"]);
  });

  it("preserves title and body", () => {
    const [u] = parseIssues(featureDir);
    expect(u.title).toBe("Title A");
    expect(u.spec).toMatch(/Body A line 1\./);
    expect(u.spec).toMatch(/Body A line 2\./);
  });

  it("skips files with no/invalid Status line without crashing", () => {
    expect(() => parseIssues(featureDir)).not.toThrow();
    const slugs = parseIssues(featureDir).map((u) => u.slug);
    expect(slugs).not.toContain("02-b");
    expect(slugs).not.toContain("03-c");
  });
});

describe("slugFromIssueFilename", () => {
  it("strips a leading NN- ordering prefix and trailing .md", () => {
    expect(slugFromIssueFilename("06-sync-status.md")).toBe("sync-status");
  });

  it("leaves a filename with no numeric prefix unchanged (besides .md)", () => {
    expect(slugFromIssueFilename("sync-status.md")).toBe("sync-status");
  });

  it("strips multi-digit prefixes", () => {
    expect(slugFromIssueFilename("123-multi-word-thing.md")).toBe("multi-word-thing");
  });

  it("is a no-op for a name with no .md extension and no prefix", () => {
    expect(slugFromIssueFilename("plain-name")).toBe("plain-name");
  });
});
