import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { wrapWithSeatbelt } from "../src/sandbox.js";

/**
 * initRepo: places the MAIN repo (and therefore .git) under $HOME so that its
 * git common dir is NOT reachable via the TMP allowlist.  Only the explicit
 * GIT_COMMON_DIR sandbox param makes it writable — proving that rule is needed.
 * The worktree lives under tmpdir() (still allowed via TMP) so the test can
 * write files there normally.
 */
function initRepo(): { root: string; worktree: string } {
  // Main repo: in $HOME so .git is NOT under TMP
  const root = mkdtempSync(join(homedir(), ".chakravyuh-sbtest-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root });
  g("init", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(root, "README.md"), "hi");
  g("add", ".");
  g("commit", "-m", "init");

  // Worktree: under tmpdir() — writable via TMP, but .git common dir is in root ($HOME)
  const wtBase = mkdtempSync(join(tmpdir(), "sup-sb-wt-"));
  const worktree = join(wtBase, "feature-x");
  execFileSync("git", ["-C", root, "worktree", "add", "-b", "test/sandbox", worktree]);
  return { root, worktree };
}

let tmpRoot: string;
let worktree: string;

describe("wrapWithSeatbelt - argv shape (all platforms)", () => {
  beforeEach(() => {
    ({ root: tmpRoot, worktree } = initRepo());
  });
  afterEach(() => {
    // Clean up both homedir main repo and tmpdir worktree base
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(join(worktree, ".."), { recursive: true, force: true });
  });

  it("returns argv unchanged when enabled:false", () => {
    const argv = ["node", "x"];
    expect(wrapWithSeatbelt(argv, { worktree, enabled: false })).toEqual(["node", "x"]);
  });

  it("returns argv unchanged when enabled:false regardless of platform", () => {
    const argv = ["echo", "hi"];
    const result = wrapWithSeatbelt(argv, { worktree, enabled: false });
    expect(result).toEqual(["echo", "hi"]);
  });
});

describe.runIf(process.platform === "darwin")("wrapWithSeatbelt - darwin sandbox", () => {
  beforeEach(() => {
    ({ root: tmpRoot, worktree } = initRepo());
  });
  afterEach(() => {
    // Clean up homedir main repo (contains .git) and tmpdir worktree base
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(join(worktree, ".."), { recursive: true, force: true });
  });

  it("returns sandbox-exec argv with 7 -D params when enabled:true on darwin", () => {
    const result = wrapWithSeatbelt(["node", "x"], { worktree, enabled: true });
    expect(result[0]).toBe("sandbox-exec");
    expect(result[1]).toBe("-f");
    // Count -D params
    const dParams = result.filter((a) => a === "-D");
    expect(dParams.length).toBe(7);
    // Original argv at end
    expect(result.slice(-2)).toEqual(["node", "x"]);
  });

  it("write INSIDE worktree succeeds", () => {
    const insideFile = join(worktree, "sandbox_test_inside.txt");
    const wrapped = wrapWithSeatbelt(
      ["/bin/sh", "-c", `touch "${insideFile}"`],
      { worktree, enabled: true },
    );
    spawnSync(wrapped[0], wrapped.slice(1), { encoding: "utf8" });
    expect(existsSync(insideFile)).toBe(true);
  });

  it("write OUTSIDE all allowlisted roots is denied", () => {
    // Target a path in $HOME that is not any allowlisted root
    const outsideFile = join(homedir(), "chakravyuh_sandbox_should_fail.txt");
    // ensure it doesn't exist before
    rmSync(outsideFile, { force: true });
    const wrapped = wrapWithSeatbelt(
      ["/bin/sh", "-c", `touch "${outsideFile}" 2>/dev/null; exit 0`],
      { worktree, enabled: true },
    );
    spawnSync(wrapped[0], wrapped.slice(1), { encoding: "utf8" });
    // File should NOT exist — sandbox denied the write
    expect(existsSync(outsideFile)).toBe(false);
    // Cleanup just in case
    rmSync(outsideFile, { force: true });
  });

  it("git commit inside the sandbox worktree succeeds (GIT_COMMON_DIR is allowed)", () => {
    // The main repo's .git is under $HOME (NOT under TMP), so only the explicit
    // GIT_COMMON_DIR sandbox param makes git writes to the common dir possible.
    // This test genuinely exercises that rule.
    writeFileSync(join(worktree, "sandboxed.txt"), "hello from sandbox");
    const cmd = `cd "${worktree}" && git add -A && git commit -m sandboxed`;
    const wrapped = wrapWithSeatbelt(
      ["/bin/sh", "-c", cmd],
      { worktree, enabled: true },
    );
    const r = spawnSync(wrapped[0], wrapped.slice(1), { encoding: "utf8", env: { ...process.env } });
    // Commit should succeed because GIT_COMMON_DIR (in $HOME) is explicitly allowed
    expect(r.status).toBe(0);
    // Verify commit landed
    const log = execFileSync("git", ["log", "--oneline"], { cwd: worktree }).toString();
    expect(log).toMatch(/sandboxed/);
  });
});
