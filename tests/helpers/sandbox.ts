import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "../../src/domain.js";

// A tiny JS repo with ONE failing test. health.sh runs the test.
export function seedSandbox(): { project: Project; backlog: string } {
  const root = mkdtempSync(join(tmpdir(), "sup-sbx-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: root });
  g("init", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");

  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "add.mjs"), "export function add(a, b) { return 0; } // BUG: returns 0\n");
  writeFileSync(join(root, "src", "add.test.mjs"),
    "import assert from 'node:assert';\nimport { add } from './add.mjs';\nassert.equal(add(2, 3), 5);\nconsole.log('ok');\n");
  writeFileSync(join(root, "health.sh"), "#!/usr/bin/env bash\nnode src/add.test.mjs\n");
  execFileSync("chmod", ["+x", join(root, "health.sh")]);
  writeFileSync(join(root, ".gitignore"),
    "backlog.md\nsupervisor.db\n*.db-wal\n*.db-shm\ncurrent.md\n");
  g("add", "."); g("commit", "-m", "init: failing add");

  const project: Project = {
    id: "sandbox", root, worktreeBase: join(root, "..", `wt-sbx-${Date.now()}`),
    baseBranch: "main", healthCmd: "bash health.sh",
  };
  const backlog = `# Backlog\n\n## fix-add\ntitle: Fix add to return a+b\nThe function in src/add.mjs returns 0. Make it return a + b so src/add.test.mjs passes. Keep the change minimal.\n`;
  const backlogPath = join(root, "backlog.md");
  writeFileSync(backlogPath, backlog);
  return { project, backlog: backlogPath };
}
