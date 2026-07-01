import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piLogPath, createFileTee } from "../src/pi-log.js";

describe("piLogPath", () => {
  it("formats <logDir>/<slug>-<role>-a<attempt>.log", () => {
    expect(piLogPath("/logs", "fix-add", "maker", 1)).toBe("/logs/fix-add-maker-a1.log");
  });

  it("is pure: same inputs, same output, no filesystem touch", () => {
    expect(piLogPath("/x", "s", "checker", 3)).toBe(piLogPath("/x", "s", "checker", 3));
  });
});

describe("createFileTee", () => {
  it("appends streamed chunks to <logDir>/<slug>-<role>-a<attempt>.log", () => {
    const logDir = mkdtempSync(join(tmpdir(), "sup-pi-log-"));
    const tee = createFileTee(logDir, "fix-add", "maker", 1);
    tee("stub-");
    tee("ok");

    const logged = readFileSync(piLogPath(logDir, "fix-add", "maker", 1), "utf8");
    expect(logged).toBe("stub-ok");
  });

  it("creates a missing logDir on first chunk (fresh loops/<proj>/logs/ — not pre-made)", () => {
    // Regression: mkdtempSync above pre-creates the dir, hiding the real first-run case where
    // loops/<proj>/logs/ does not exist yet. Without a lazy mkdir the tee throws ENOENT and is
    // silently inert (best-effort swallows it), so no log is ever written.
    const base = mkdtempSync(join(tmpdir(), "sup-pi-log-base-"));
    const logDir = join(base, "logs"); // does NOT exist yet
    const tee = createFileTee(logDir, "fix-add", "maker", 2);
    tee("stub-ok");

    const logged = readFileSync(piLogPath(logDir, "fix-add", "maker", 2), "utf8");
    expect(logged).toContain("stub-ok");
  });

  it("is best-effort: a write failure (unwritable logDir) never throws", () => {
    const base = mkdtempSync(join(tmpdir(), "sup-pi-log-ro-"));
    const logDir = join(base, "locked");
    mkdirSync(logDir, { mode: 0o400 }); // read-only: appendFileSync will fail
    const tee = createFileTee(logDir, "fix-add", "maker", 3);
    expect(() => tee("stub-ok")).not.toThrow();
  });
});
