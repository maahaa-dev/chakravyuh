import { describe, it, expect } from "vitest";
import { runHealth } from "../src/gates.js";

describe("runHealth", () => {
  it("returns exitCode 0 for a passing command", () => {
    const r = runHealth("exit 0", process.cwd());
    expect(r.exitCode).toBe(0);
    expect(r.command).toBe("exit 0");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns non-zero exitCode for a failing command without throwing", () => {
    expect(runHealth("exit 7", process.cwd()).exitCode).toBe(7);
  });

  it("captures combined stdout+stderr into output (so a failed gate is debuggable)", () => {
    const r = runHealth("echo to-out; echo to-err 1>&2; exit 1", process.cwd());
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("to-out");
    expect(r.output).toContain("to-err");
  });

  it("kills a command that exceeds timeoutMs instead of hanging the loop", () => {
    const r = runHealth("sleep 10", process.cwd(), 150);
    expect(r.exitCode).not.toBe(0);       // signalled/killed -> non-zero
    expect(r.durationMs).toBeLessThan(5000); // did NOT wait the full 10s
  });
});
