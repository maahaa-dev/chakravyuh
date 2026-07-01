import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setIssueStatus, mapDbStatusToIssueStatus, syncStatus, parseIssueStatus } from "../src/sync-status.js";
import type { WorkUnit } from "../src/domain.js";

let featureDir: string;
let issuesDir: string;

beforeEach(() => {
  featureDir = mkdtempSync(join(tmpdir(), "sync-status-"));
  issuesDir = join(featureDir, "issues");
  mkdirSync(issuesDir);
});

afterEach(() => {
  rmSync(featureDir, { recursive: true, force: true });
});

describe("mapDbStatusToIssueStatus", () => {
  it("maps approved -> ready-for-human", () => {
    expect(mapDbStatusToIssueStatus("approved")).toBe("ready-for-human");
  });

  it("maps failed -> needs-triage", () => {
    expect(mapDbStatusToIssueStatus("failed")).toBe("needs-triage");
  });

  it("returns null for non-terminal or unknown statuses", () => {
    expect(mapDbStatusToIssueStatus("pending")).toBeNull();
    expect(mapDbStatusToIssueStatus("building")).toBeNull();
    expect(mapDbStatusToIssueStatus("done")).toBeNull();
    expect(mapDbStatusToIssueStatus(undefined)).toBeNull();
  });
});

describe("setIssueStatus", () => {
  it("rewrites only the Status: line, preserving the rest byte-for-byte, and returns true", () => {
    const path = join(issuesDir, "01-a.md");
    writeFileSync(path, `Status: ready-for-agent\n# Title A\n\nBody line 1.\nBody line 2.\n`);

    const changed = setIssueStatus(path, "ready-for-human");

    expect(changed).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(
      `Status: ready-for-human\n# Title A\n\nBody line 1.\nBody line 2.\n`,
    );
  });

  it("is idempotent: a second call with the same status is a no-op and returns false", () => {
    const path = join(issuesDir, "01-a.md");
    writeFileSync(path, `Status: ready-for-agent\n# Title A\n\nBody.\n`);

    setIssueStatus(path, "ready-for-human");
    const after1 = readFileSync(path, "utf8");
    const changed2 = setIssueStatus(path, "ready-for-human");
    const after2 = readFileSync(path, "utf8");

    expect(changed2).toBe(false);
    expect(after2).toBe(after1);
  });

  it("leaves a file with no Status: line untouched and returns false", () => {
    const path = join(issuesDir, "03-c.md");
    const original = `# Title C\n\nBody C.\n`;
    writeFileSync(path, original);

    const changed = setIssueStatus(path, "ready-for-human");

    expect(changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(original);
  });
});

describe("syncStatus", () => {
  function fakeStore(units: Record<string, WorkUnit>) {
    return { getWorkUnit: (id: string) => units[id] ?? null } as any;
  }

  it("rewrites an issue's Status: line per the latest terminal DB status", () => {
    writeFileSync(
      join(issuesDir, "01-a.md"),
      `Status: ready-for-agent\n# Title A\n\nBody.\n`,
    );
    const store = fakeStore({
      "issues:a": {
        id: "issues:a", projectId: "issues", slug: "a", title: "Title A", spec: "Body.",
        status: "approved", attempt: 1, maxAttempts: 3, createdAt: "t", updatedAt: "t",
      },
    });

    const result = syncStatus(featureDir, store, "issues");

    expect(result.changes).toEqual([
      { slug: "a", from: "ready-for-agent", to: "ready-for-human" },
    ]);
    expect(readFileSync(join(issuesDir, "01-a.md"), "utf8")).toBe(
      `Status: ready-for-human\n# Title A\n\nBody.\n`,
    );
  });

  it("a second run is a no-op", () => {
    writeFileSync(
      join(issuesDir, "01-a.md"),
      `Status: ready-for-agent\n# Title A\n\nBody.\n`,
    );
    const store = fakeStore({
      "issues:a": {
        id: "issues:a", projectId: "issues", slug: "a", title: "Title A", spec: "Body.",
        status: "approved", attempt: 1, maxAttempts: 3, createdAt: "t", updatedAt: "t",
      },
    });

    syncStatus(featureDir, store, "issues");
    const result2 = syncStatus(featureDir, store, "issues");

    expect(result2.changes).toEqual([]);
  });

  it("reports files with no Status: line and leaves them untouched", () => {
    const original = `# Title C\n\nBody C.\n`;
    writeFileSync(join(issuesDir, "03-c.md"), original);
    const store = fakeStore({
      "issues:c": {
        id: "issues:c", projectId: "issues", slug: "c", title: "Title C", spec: "Body C.",
        status: "approved", attempt: 1, maxAttempts: 3, createdAt: "t", updatedAt: "t",
      },
    });

    const result = syncStatus(featureDir, store, "issues");

    expect(result.changes).toEqual([]);
    expect(result.noStatusLine).toEqual(["03-c.md"]);
    expect(readFileSync(join(issuesDir, "03-c.md"), "utf8")).toBe(original);
  });

  it("leaves unchanged any issue with no terminal run yet", () => {
    writeFileSync(
      join(issuesDir, "02-b.md"),
      `Status: ready-for-agent\n# Title B\n\nBody.\n`,
    );
    const store = fakeStore({
      "issues:b": {
        id: "issues:b", projectId: "issues", slug: "b", title: "Title B", spec: "Body.",
        status: "pending", attempt: 0, maxAttempts: 3, createdAt: "t", updatedAt: "t",
      },
    });

    const result = syncStatus(featureDir, store, "issues");

    expect(result.changes).toEqual([]);
    expect(readFileSync(join(issuesDir, "02-b.md"), "utf8")).toBe(
      `Status: ready-for-agent\n# Title B\n\nBody.\n`,
    );
  });

  it("warns instead of silently conflating two files that resolve to the same slug, and leaves both untouched", () => {
    writeFileSync(
      join(issuesDir, "06-foo.md"),
      `Status: ready-for-agent\n# Title Foo 6\n\nBody six.\n`,
    );
    writeFileSync(
      join(issuesDir, "07-foo.md"),
      `Status: ready-for-agent\n# Title Foo 7\n\nBody seven.\n`,
    );
    const store = fakeStore({
      "issues:foo": {
        id: "issues:foo", projectId: "issues", slug: "foo", title: "Title Foo", spec: "Body.",
        status: "approved", attempt: 1, maxAttempts: 3, createdAt: "t", updatedAt: "t",
      },
    });

    const result = syncStatus(featureDir, store, "issues");

    expect(result.changes).toEqual([]);
    expect(result.collisions).toEqual([
      { slug: "foo", files: ["06-foo.md", "07-foo.md"] },
    ]);
    expect(readFileSync(join(issuesDir, "06-foo.md"), "utf8")).toMatch(/^Status: ready-for-agent/);
    expect(readFileSync(join(issuesDir, "07-foo.md"), "utf8")).toMatch(/^Status: ready-for-agent/);
  });
});

describe("parseIssueStatus", () => {
  it("returns the trimmed status value", () => {
    expect(parseIssueStatus("# Title\nStatus: ready-for-agent\nbody")).toBe("ready-for-agent");
  });
  it("is case-insensitive on the label and tolerates extra spacing", () => {
    expect(parseIssueStatus("status:   needs-triage  ")).toBe("needs-triage");
  });
  it("returns null when there is no Status line", () => {
    expect(parseIssueStatus("# Title\nno status here")).toBeNull();
  });
  it("reads only the first Status line", () => {
    expect(parseIssueStatus("Status: a\nStatus: b")).toBe("a");
  });
});
