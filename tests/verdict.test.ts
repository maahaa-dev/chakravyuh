import { describe, it, expect } from "vitest";
import { parseVerdict } from "../src/verdict.js";

describe("parseVerdict", () => {
  it("extracts the last fenced json block", () => {
    const text = 'analysis...\n```json\n{"pass":true,"summary":"ok","blockers":[]}\n```\n';
    const v = parseVerdict(text);
    expect(v.pass).toBe(true);
    expect(v.summary).toBe("ok");
  });

  it("uses the LAST json block when several exist", () => {
    const text = '```json\n{"pass":false,"summary":"a","blockers":["x"]}\n```\n' +
      'then\n```json\n{"pass":true,"summary":"b","blockers":[]}\n```';
    expect(parseVerdict(text).summary).toBe("b");
    expect(parseVerdict(text).pass).toBe(true);
  });

  it("fails closed when no json block present", () => {
    const v = parseVerdict("no verdict here");
    expect(v.pass).toBe(false);
    expect(v.blockers.join(" ")).toMatch(/no verdict/i);
  });

  it("fails closed on malformed json", () => {
    const v = parseVerdict('```json\n{pass:true}\n```');
    expect(v.pass).toBe(false);
  });

  it("fails closed on schema type mismatch", () => {
    const v = parseVerdict('```json\n{"pass":"yes","summary":"fine"}\n```');
    expect(v.pass).toBe(false);
    expect(v.blockers[0]).toMatch(/schema/i);
  });

  it("tolerates an uppercase ```JSON fence (agents are inconsistent about the tag case)", () => {
    const v = parseVerdict('```JSON\n{"pass":true,"summary":"ok","blockers":[]}\n```');
    expect(v.pass).toBe(true);
    expect(v.summary).toBe("ok");
  });

  it("attaches provided gate evidence", () => {
    const ev = [{ command: "bash health.sh", exitCode: 0, durationMs: 12 }];
    const v = parseVerdict('```json\n{"pass":true,"summary":"s","blockers":[]}\n```', ev);
    expect(v.evidence).toEqual(ev);
  });
});
