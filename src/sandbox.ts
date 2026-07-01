import { mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const DEFAULT_PROFILE = fileURLToPath(new URL("../sandbox.sb", import.meta.url));

/**
 * Wraps an argv in a macOS Seatbelt `sandbox-exec` invocation that confines the maker's writes to an
 * allowlist (worktree, `~/.pi`, `$TMPDIR`, the git common dir, and caches; SSH/AWS denied). Returns
 * the argv unchanged when confinement is disabled, or — with a warning — off-darwin, where the maker
 * runs unsandboxed (Linux bubblewrap is a TODO). Resolving the git common dir is critical because a
 * worktree's `.git` lives outside it; failure to resolve it throws rather than running unconfined.
 */
export function wrapWithSeatbelt(
  argv: string[],
  opts: { worktree: string; enabled: boolean; profilePath?: string },
): string[] {
  if (!opts.enabled) return argv;

  if (process.platform !== "darwin") {
    process.stderr.write(
      "[sandbox] WARNING: sandbox is enabled but platform is not darwin; skipping (Linux bubblewrap is a TODO)\n",
    );
    return argv;
  }

  // Resolve WORKTREE
  const WORKTREE = realpathSync(opts.worktree);

  // Resolve PI_DIR (create if missing)
  const piDirRaw = join(homedir(), ".pi");
  mkdirSync(piDirRaw, { recursive: true });
  const PI_DIR = realpathSync(piDirRaw);

  // Resolve TMP
  const TMP = realpathSync(process.env["TMPDIR"] ?? tmpdir());

  // Resolve GIT_COMMON_DIR — critical for git worktrees where .git lives outside the worktree
  let gitCommonRaw: string;
  try {
    gitCommonRaw = execFileSync("git", ["-C", WORKTREE, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
    }).trim();
  } catch {
    gitCommonRaw = join(WORKTREE, ".git");
  }
  let GIT_COMMON_DIR: string;
  try {
    GIT_COMMON_DIR = realpathSync(
      isAbsolute(gitCommonRaw) ? gitCommonRaw : join(WORKTREE, gitCommonRaw),
    );
  } catch (cause) {
    throw new Error(`sandbox: could not resolve git common dir for ${WORKTREE}: ${cause}`);
  }

  // Resolve HOME_CACHE (node/npm/v8 caches)
  const homeCacheRaw = join(homedir(), "Library", "Caches");
  mkdirSync(homeCacheRaw, { recursive: true });
  const HOME_CACHE = realpathSync(homeCacheRaw);

  // SSH_DIR and AWS_DIR: do NOT realpath (may not exist); deny rule is harmless if dir absent
  const SSH_DIR = join(homedir(), ".ssh");
  const AWS_DIR = join(homedir(), ".aws");

  const profilePath = opts.profilePath ?? DEFAULT_PROFILE;

  return [
    "sandbox-exec",
    "-f", profilePath,
    "-D", `WORKTREE=${WORKTREE}`,
    "-D", `PI_DIR=${PI_DIR}`,
    "-D", `TMP=${TMP}`,
    "-D", `GIT_COMMON_DIR=${GIT_COMMON_DIR}`,
    "-D", `HOME_CACHE=${HOME_CACHE}`,
    "-D", `SSH_DIR=${SSH_DIR}`,
    "-D", `AWS_DIR=${AWS_DIR}`,
    ...argv,
  ];
}
