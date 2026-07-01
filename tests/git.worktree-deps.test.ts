import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree } from "../src/git.js";
import type { Project } from "../src/domain.js";

function initRepo(): Project {
  const root = mkdtempSync(join(tmpdir(), "sup-git-deps-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root });
  g("init", "-b", "main");
  g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(root, "README.md"), "hi");
  g("add", "."); g("commit", "-m", "init");
  return { id: "p", root, worktreeBase: join(root, "..", `wt-${Date.now()}`),
           baseBranch: "main", healthCmd: "true" };
}

describe("addWorktree node_modules linking", () => {
  let project: Project;
  beforeEach(() => { project = initRepo(); });

  it("symlinks node_modules into the worktree and excludes it from git status", () => {
    const nm = join(project.root, "node_modules");
    mkdirSync(nm);
    writeFileSync(join(nm, "marker.txt"), "deps");

    const wt = addWorktree(project, "feature-x");

    const wtNm = join(wt, "node_modules");
    expect(existsSync(wtNm)).toBe(true);
    expect(realpathSync(wtNm)).toBe(realpathSync(nm));
    expect(readFileSync(join(wtNm, "marker.txt"), "utf8")).toBe("deps");

    const status = execFileSync("git", ["status", "--porcelain"], { cwd: wt }).toString();
    expect(status).toBe("");
  });

  it("does nothing when the root has no node_modules", () => {
    const wt = addWorktree(project, "feature-y");
    expect(existsSync(join(wt, "node_modules"))).toBe(false);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: wt }).toString();
    expect(status).toBe("");
  });
});
