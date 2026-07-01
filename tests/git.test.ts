import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, removeWorktree, deleteBranch, rootIsClean, commitAll, isPathInside, withGitLock } from "../src/git.js";
import type { Project } from "../src/domain.js";

function initRepo(): Project {
  const root = mkdtempSync(join(tmpdir(), "sup-git-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root });
  g("init", "-b", "main");
  g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(root, "README.md"), "hi");
  g("add", "."); g("commit", "-m", "init");
  return { id: "p", root, worktreeBase: join(root, "..", `wt-${Date.now()}`),
           baseBranch: "main", healthCmd: "true" };
}

describe("git", () => {
  let project: Project;
  beforeEach(() => { project = initRepo(); });

  it("addWorktree creates a branch worktree", () => {
    const wt = addWorktree(project, "feature-x");
    expect(existsSync(wt)).toBe(true);
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd: wt }).toString().trim();
    expect(branch).toBe("chakravyuh/feature-x");
  });

  it("rootIsClean true on clean root, false when tracked file modified", () => {
    expect(rootIsClean(project.root)).toBe(true);
    // Modify a tracked file — this is the kind of root leak the maker could cause.
    writeFileSync(join(project.root, "README.md"), "leaked change");
    expect(rootIsClean(project.root)).toBe(false);
  });

  it("rootIsClean false after a stray untracked write", () => {
    expect(rootIsClean(project.root)).toBe(true);
    writeFileSync(join(project.root, "leak.txt"), "x");
    expect(rootIsClean(project.root)).toBe(false);
  });

  it("commitAll commits changes inside the worktree", () => {
    const wt = addWorktree(project, "feature-y");
    writeFileSync(join(wt, "new.txt"), "data");
    commitAll(wt, "feat: add new");
    const log = execFileSync("git", ["log", "--oneline"], { cwd: wt }).toString();
    expect(log).toMatch(/add new/);
  });

  it("addWorktree is idempotent — a re-run of the same slug does not throw and resets to base", () => {
    const wt1 = addWorktree(project, "redo");
    writeFileSync(join(wt1, "scratch.txt"), "first attempt");
    // second run of the same slug (prior worktree/branch still present) must not blow up
    const wt2 = addWorktree(project, "redo");
    expect(wt2).toBe(wt1);
    expect(existsSync(wt2)).toBe(true);
    // -B reset the branch to base → the prior attempt's stray file is gone
    expect(existsSync(join(wt2, "scratch.txt"))).toBe(false);
  });

  it("addWorktree REFUSES to reset a branch carrying unmerged commits (protects approved work)", () => {
    const wt = addWorktree(project, "approved-x");
    writeFileSync(join(wt, "f.txt"), "landed");
    commitAll(wt, "feat: landed"); // chakravyuh/approved-x now has a commit beyond base
    removeWorktree(project, wt); // worktree gone, branch kept (the approved-but-unmerged state)
    expect(() => addWorktree(project, "approved-x")).toThrow(/unmerged commits/);
    // the landed commit survives the refused re-run
    const log = execFileSync("git", ["-C", project.root, "log", "--oneline", "chakravyuh/approved-x"]).toString();
    expect(log).toMatch(/landed/);
  });

  it("removeWorktree removes the dir but KEEPS the branch", () => {
    const wt = addWorktree(project, "keepme");
    writeFileSync(join(wt, "f.txt"), "x");
    commitAll(wt, "feat: keep");
    removeWorktree(project, wt);
    expect(existsSync(wt)).toBe(false);
    const branches = execFileSync("git", ["branch", "--list", "chakravyuh/keepme"], { cwd: project.root }).toString();
    expect(branches).toMatch(/chakravyuh\/keepme/);
  });

  it("deleteBranch removes a branch and is a no-op when absent", () => {
    const wt = addWorktree(project, "dropme");
    writeFileSync(join(wt, "d.txt"), "x");
    commitAll(wt, "feat: drop");
    removeWorktree(project, wt);
    deleteBranch(project.root, "chakravyuh/dropme");
    const branches = execFileSync("git", ["branch", "--list", "chakravyuh/dropme"], { cwd: project.root }).toString();
    expect(branches.trim()).toBe("");
    expect(() => deleteBranch(project.root, "chakravyuh/does-not-exist")).not.toThrow();
  });
});

describe("withGitLock (coarse git mutex)", () => {
  it("runs fn and returns its value", () => {
    expect(withGitLock(() => 42)).toBe(42);
  });

  it("releases the lock even when fn throws, so the next call still succeeds", () => {
    expect(() => withGitLock(() => { throw new Error("boom"); })).toThrow("boom");
    expect(withGitLock(() => "after-throw")).toBe("after-throw");
  });

  it("throws on reentrancy \u2014 a nested call while the lock is held", () => {
    expect(() => withGitLock(() => withGitLock(() => 1))).toThrow(/git mutation attempted/);
  });

  it("addWorktree/commitAll/removeWorktree/deleteBranch all funnel through the lock (integration)", () => {
    // Not a race test (execFileSync is synchronous, so two mutations can never truly interleave in
    // one process) — this just confirms wrapping the real git mutations in withGitLock doesn't
    // change their observable behaviour.
    const project = initRepo();
    const wt = addWorktree(project, "lock-check");
    writeFileSync(join(wt, "f.txt"), "x");
    commitAll(wt, "feat: lock check");
    removeWorktree(project, wt);
    deleteBranch(project.root, "chakravyuh/lock-check");
    expect(existsSync(wt)).toBe(false);
  });
});

describe("isPathInside (leak-guard predicate)", () => {
  it("is true for the root itself and any descendant", () => {
    expect(isPathInside("/a/b", "/a/b")).toBe(true);
    expect(isPathInside("/a/b/logs", "/a/b")).toBe(true);
    expect(isPathInside("/a/b/c/d.log", "/a/b")).toBe(true);
  });

  it("is false for a sibling or an outside path", () => {
    expect(isPathInside("/a/c", "/a/b")).toBe(false);
    expect(isPathInside("/a/b-logs", "/a/b")).toBe(false); // prefix-but-not-child
    expect(isPathInside("/x/y", "/a/b")).toBe(false);
  });

  it("normalizes `..` and relative segments before comparing", () => {
    expect(isPathInside("/a/b/../c", "/a/b")).toBe(false); // resolves to /a/c
    expect(isPathInside("/a/b/sub/../logs", "/a/b")).toBe(true); // resolves to /a/b/logs
  });
});
