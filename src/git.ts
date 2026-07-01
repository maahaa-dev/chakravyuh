import { execFileSync } from "node:child_process";
import { existsSync, symlinkSync, appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Project } from "./domain.js";

/**
 * A coarse, in-process single-writer mutex serializing ALL git mutations ({@link addWorktree},
 * {@link commitAll}, {@link removeWorktree}, {@link deleteBranch}) across concurrent `--all` unit
 * runs. `git worktree add`/`remove` race on the shared `.git/worktrees` index when two run at once
 * in the same root.
 *
 * Every mutating export below funnels its body through {@link withGitLock} itself — the lock lives
 * *inside* `git.ts`, not at the call site — so `addWorktree`/`removeWorktree`/`deleteBranch`/
 * `commitAll` keep their existing synchronous signatures. That matters because `loop.ts`'s
 * `LoopDeps` calls them synchronously and uses the return value immediately (e.g.
 * `const worktree = deps.addWorktree(...)`); making the lock visible at the call site would force
 * those calls to become async and ripple into `loop.ts`/`LoopDeps`, which is out of scope here.
 *
 * The mutations themselves run via `execFileSync`, which blocks Node's single thread for the
 * duration of the git call — no other JS (including another queued unit's `addWorktree`) can run
 * until it returns, so two mutations can never actually interleave today. `withGitLock` is a
 * reentrancy *guard*, not a scheduler: it is the belt to that already-guaranteed-by-Node's-runtime
 * suspenders, and it turns any future change that makes a mutation yield mid-call (e.g. swapping
 * `execFileSync` for `exec`+`await`) into a loud, immediate throw instead of a silent worktree-index
 * race. Pi spawns (the expensive, long-running part of a unit) are never wrapped in it.
 */
let gitLockHeld = false;

/**
 * Runs `fn` while holding the coarse git lock, releasing it in a `finally` so a throwing `fn` still
 * frees it for the next caller. Throws immediately, without running `fn`, if the lock is already
 * held — a call from inside another `withGitLock` call, which should be structurally impossible
 * given every mutating export runs to completion synchronously (see the module doc above).
 */
export function withGitLock<T>(fn: () => T): T {
  if (gitLockHeld) {
    throw new Error(
      "withGitLock: git mutation attempted while another is in flight — this should be impossible " +
      "given synchronous execFileSync; something now yields mid-mutation and the coarse lock caught it",
    );
  }
  gitLockHeld = true;
  try {
    return fn();
  } finally {
    gitLockHeld = false;
  }
}

function git(cwd: string, ...args: string[]): string {
  // Capture stderr instead of inheriting it: several call sites probe-then-catch (worktree remove on
  // a missing path, branch -D on a stale ref) where git writes a benign `fatal:`/`error:` line to
  // stderr. Inheriting leaks that noise to the terminal; piping keeps it off-screen and attaches it
  // to the thrown error's `.stderr` for real failures.
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function branchExists(root: string, branch: string): boolean {
  try { git(root, "rev-parse", "--verify", "--quiet", branch); return true; } catch { return false; }
}

/**
 * Creates a fresh worktree at `worktreeBase/<slug>` on branch `chakravyuh/<slug>`, forked from the
 * project's base branch, and returns its path. Idempotent for a crashed run: it clears a stale
 * worktree dir and prunes first. Throws rather than clobber an existing branch that carries commits
 * beyond base — that is approved-but-unmerged work the human still owns.
 */
export function addWorktree(project: Project, slug: string): string {
  return withGitLock(() => {
    const path = join(project.worktreeBase, slug);
    const branch = `chakravyuh/${slug}`;
    // Idempotent re-run: clear any stale worktree dir left by a crashed run (this does NOT touch
    // the branch). Then, if the branch still exists, only recreate it when it carries no commits
    // beyond base — a branch with unmerged commits is approved-but-unmerged work, so refuse to
    // clobber it (the old `-B` silently reset it and destroyed the landed commit).
    try { git(project.root, "worktree", "remove", "--force", path); } catch { /* none to remove */ }
    try { git(project.root, "worktree", "prune"); } catch { /* best effort */ }
    if (branchExists(project.root, branch)) {
      const unmerged = git(project.root, "rev-list", `${project.baseBranch}..${branch}`).trim();
      if (unmerged !== "") {
        throw new Error(
          `addWorktree: branch ${branch} has unmerged commits; refusing to reset it. ` +
          `Merge or delete ${branch} before re-running slug ${slug}.`,
        );
      }
      git(project.root, "branch", "-D", branch); // safe: no commits beyond base
    }
    git(project.root, "worktree", "add", "-b", branch, path, project.baseBranch);
    linkNodeModules(project.root, path);
    return path;
  });
}

/**
 * Best-effort: if the project root has a `node_modules` directory and the fresh worktree has
 * none, symlink it in so the maker and health gate can run tests without a separate install step.
 * Also appends `node_modules` to the worktree's local git exclude file (info/exclude) so the
 * symlink never appears in `git status` or gets swept up by `commitAll`'s `git add -A` — some
 * repos' `.gitignore` only matches the directory form and misses a symlink. Idempotent and never
 * throws: a missing root node_modules or a pre-existing worktree entry is a no-op.
 */
function linkNodeModules(root: string, worktree: string): void {
  try {
    const rootNodeModules = join(root, "node_modules");
    const worktreeNodeModules = join(worktree, "node_modules");
    if (!existsSync(rootNodeModules) || existsSync(worktreeNodeModules)) return;
    symlinkSync(rootNodeModules, worktreeNodeModules, "dir");

    const excludePath = git(worktree, "rev-parse", "--git-path", "info/exclude").trim();
    const absExcludePath = isAbsolute(excludePath) ? excludePath : join(worktree, excludePath);
    const existing = existsSync(absExcludePath) ? readFileSync(absExcludePath, "utf8") : "";
    if (!existing.split("\n").map((l) => l.trim()).includes("node_modules")) {
      mkdirSync(dirname(absExcludePath), { recursive: true });
      const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
      appendFileSync(absExcludePath, `${prefix}node_modules\n`);
    }
  } catch { /* best effort: deps linking must never break worktree creation */ }
}

/**
 * Force-deletes a branch, swallowing the error if it is already gone (best-effort teardown).
 */
export function deleteBranch(root: string, branch: string): void {
  withGitLock(() => {
    try { git(root, "branch", "-D", branch); } catch { /* already gone */ }
  });
}

/**
 * Reports whether a tree has no uncommitted changes (`git status --porcelain` is empty). Backs the
 * root-leak guard (the maker must touch only the worktree) and the no-changes-to-commit check.
 */
export function rootIsClean(root: string): boolean {
  return git(root, "status", "--porcelain").trim() === "";
}

/**
 * Whether `child` resolves to `root` or any path beneath it — the predicate that guards the
 * leak-guard invariant (e.g. a per-run log dir must NOT sit inside `project.root`, or writing to it
 * would dirty the tree and {@link rootIsClean} would fail the unit for the wrong reason). Both paths
 * are resolved first, so `..` segments and relative inputs compare correctly; a sibling that merely
 * shares a string prefix (`/a/b-logs` vs `/a/b`) is correctly outside.
 */
export function isPathInside(child: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Stages everything in the worktree and commits it with `message`. Throws if there is nothing to
 * commit, so callers must verify the tree is dirty first.
 */
export function commitAll(worktree: string, message: string): void {
  withGitLock(() => {
    git(worktree, "add", "-A");
    git(worktree, "commit", "-m", message);
  });
}

/**
 * Force-removes a unit's worktree directory. Unlike the others this does not swallow errors — the
 * caller wraps it in best-effort cleanup.
 */
export function removeWorktree(project: Project, worktreePath: string): void {
  withGitLock(() => {
    git(project.root, "worktree", "remove", "--force", worktreePath);
  });
}
