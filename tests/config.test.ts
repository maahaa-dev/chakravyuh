import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";

function writeConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "sup-cfg-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

const valid = {
  project: { id: "p", root: "/r", worktreeBase: "/wt", baseBranch: "main", healthCmd: "true" },
  roles: {
    maker: { provider: "anthropic", model: "strong", thinking: "medium" },
    checker: { provider: "anthropic", model: "cheap", thinking: "low" },
    reviewer: { provider: "openai", model: "gpt", thinking: "low" },
  },
  backlogPath: "/r/backlog.md", dbPath: "/r/supervisor.db",
  currentMdPath: "/r/current.md", piBinPath: "/pi/cli.js",
};

describe("loadConfig", () => {
  it("loads a valid config", () => {
    expect(loadConfig(writeConfig(valid)).project.id).toBe("p");
  });
  it("throws on a config missing roles", () => {
    const bad: any = { ...valid }; delete bad.roles;
    expect(() => loadConfig(writeConfig(bad))).toThrow();
  });
  it("parses an optional budget override", () => {
    const cfg = loadConfig(writeConfig({ ...valid, budget: { hardTimeoutMs: 3_600_000 } }));
    expect(cfg.budget?.hardTimeoutMs).toBe(3_600_000);
  });
  it("rejects a below-minimum budget timeout", () => {
    expect(() => loadConfig(writeConfig({ ...valid, budget: { hardTimeoutMs: 10 } }))).toThrow();
  });
});
