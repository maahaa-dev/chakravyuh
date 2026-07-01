import { describe, it, expect, beforeAll } from "vitest";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnPi, buildPiArgs } from "../src/pi.js";

const stub = fileURLToPath(new URL("./fixtures/pi-stub.sh", import.meta.url));

function opts(over: Partial<Parameters<typeof spawnPi>[0]> = {}) {
  return {
    role: "maker" as const, cwd: process.cwd(), provider: "anthropic", model: "haiku",
    thinking: "low", tools: "read,bash,edit,write", sessionId: "s1", brief: "be brief",
    prompt: "do it", idleTimeoutMs: 5000, hardTimeoutMs: 10000,
    binPath: stub, runner: "bash", ...over,
  };
}

beforeAll(() => chmodSync(stub, 0o755));

describe("spawnPi", () => {
  it("runs the stub and parses its output", async () => {
    const r = await spawnPi(opts());
    expect(r.sessionId).toBe("sess-stub");
    expect(r.stopReason).toBe("stop");
    expect(r.text).toBe("stub-ok");
    expect(r.exitReason).toBe("exit:0");
  });

  it("kills on hard timeout when the stub hangs", async () => {
    const r = await spawnPi(opts({ hardTimeoutMs: 200, idleTimeoutMs: 200, env: { PI_STUB_SLEEP: "5" } }));
    expect(r.exitReason).toMatch(/timeout/);
    expect(r.stopReason).toBe("timeout");
  });

  it("calls tee with each raw stdout chunk before parsing, no filesystem involved", async () => {
    const chunks: string[] = [];
    const r = await spawnPi(opts({ tee: (chunk) => chunks.push(chunk) }));
    expect(r.text).toBe("stub-ok");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("")).toContain("stub-ok");
  });

  it("never breaks the run when tee throws (best-effort)", async () => {
    const r = await spawnPi(opts({ tee: () => { throw new Error("boom"); } }));
    expect(r.text).toBe("stub-ok");
    expect(r.exitReason).toBe("exit:0");
  });
});

describe("buildPiArgs", () => {
  it("emits one -e per extension, before the provider/model flags", () => {
    const args = buildPiArgs(opts({ extensions: ["/x/a.ts", "/x/b.ts"] }), "cli.js");
    const eIdxs = args.flatMap((a, i) => (a === "-e" ? [i] : []));
    expect(eIdxs.length).toBe(2);
    expect(args[eIdxs[0] + 1]).toBe("/x/a.ts");
    expect(args[eIdxs[1] + 1]).toBe("/x/b.ts");
    // extensions load before --provider so the provider override is registered in time
    expect(Math.max(...eIdxs)).toBeLessThan(args.indexOf("--provider"));
  });

  it("emits no -e when extensions are absent, prompt stays the final positional arg", () => {
    const args = buildPiArgs(opts(), "cli.js");
    expect(args).not.toContain("-e");
    expect(args[args.length - 1]).toBe("do it");
  });

  it("sanitizes the session id to Pi's charset (alphanumeric, -, _, .)", () => {
    // unit.id is `${projectId}:${slug}` → the colon is illegal in a Pi session id
    // (Pi 0.80.2: "Session id must ... contain only alphanumeric characters, '-', '_', and '.'").
    // An unsanitized colon makes the maker exit 1 with zero output. See pi-parse/worktree-hang notes.
    const args = buildPiArgs(opts({ sessionId: "sandbox:fix-add-maker-1" }), "cli.js");
    const sid = args[args.indexOf("--session-id") + 1];
    expect(sid).toBe("sandbox-fix-add-maker-1");
    expect(sid).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/);
  });
});
