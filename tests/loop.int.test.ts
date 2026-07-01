import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { seedSandbox } from "./helpers/sandbox.js";
import { parseBacklog } from "../src/store/backlog-md.js";
import { readFileSync } from "node:fs";
import { SqliteStore } from "../src/store/sqlite-store.js";
import { spawnPi } from "../src/pi.js";
import { runHealth } from "../src/gates.js";
import { addWorktree, removeWorktree, deleteBranch, rootIsClean, commitAll } from "../src/git.js";
import { runUnit } from "../src/loop.js";
import { DEFAULT_BUDGET } from "../src/domain.js";

const PI_BIN = fileURLToPath(new URL("../../pi/packages/coding-agent/dist/cli.js", import.meta.url));
const piBuilt = existsSync(PI_BIN);

// Opt-in only. This test drives a REAL provider through Pi — it needs network, credentials, and
// spends tokens — so plain `npm test` never runs it (the unit suite stays offline and provider-free
// on any machine). Enable with RUN_PI_INTEGRATION=1. Provider and models are env-configurable so it
// can run against whatever Pi is set up for; it defaults to an Anthropic Claude setup:
//   RUN_PI_INTEGRATION=1 npx vitest --run tests/loop.int.test.ts
//   RUN_PI_INTEGRATION=1 PI_IT_PROVIDER=openrouter \
//     PI_IT_MAKER_MODEL=anthropic/claude-haiku-4.5 PI_IT_VERIFIER_MODEL=openai/gpt-4o-mini \
//     npx vitest --run tests/loop.int.test.ts
const optedIn = process.env.RUN_PI_INTEGRATION === "1";
const IT_PROVIDER = process.env.PI_IT_PROVIDER ?? "anthropic";
const IT_MAKER_MODEL = process.env.PI_IT_MAKER_MODEL ?? "sonnet";
const IT_VERIFIER_MODEL = process.env.PI_IT_VERIFIER_MODEL ?? "haiku";

describe.runIf(piBuilt && optedIn)("integration: full loop on sandbox", () => {
  it("fixes a seeded failing test and approves with a commit", async () => {
    const { project, backlog } = seedSandbox();
    const unit = parseBacklog(readFileSync(backlog, "utf8"), project.id)[0];
    const store = new SqliteStore(":memory:");
    store.upsertWorkUnit(unit);

    const roles = {
      maker: { provider: IT_PROVIDER, model: IT_MAKER_MODEL, thinking: "medium" },
      checker: { provider: IT_PROVIDER, model: IT_VERIFIER_MODEL, thinking: "low" },
      reviewer: { provider: IT_PROVIDER, model: IT_VERIFIER_MODEL, thinking: "low" },
    };
    const result = await runUnit(project, unit, {
      store, spawn: spawnPi, runHealth, addWorktree, removeWorktree, deleteBranch, rootIsClean, commitAll,
      stopRequested: () => false, roles, budget: { ...DEFAULT_BUDGET, idleTimeoutMs: 120_000, hardTimeoutMs: 300_000 },
      piBinPath: PI_BIN, sandbox: true, // confine the maker under Seatbelt for the real e2e
    });

    expect(result.status).toBe("approved");
    // On approval the worktree dir is removed but the branch (chakravyuh/fix-add) is KEPT with the
    // landed commit — verify the commit on the branch ref from the main repo.
    const log = execFileSync("git", ["-C", project.root, "log", "--oneline", "chakravyuh/fix-add"]).toString();
    expect(log).toMatch(/fix-add/);
    // run log captured maker + checker + reviewer
    expect(store.runsForUnit(unit.id).map((r) => r.role)).toEqual(
      expect.arrayContaining(["maker", "checker", "reviewer"]));
    store.close();
  }, 600_000);
});
