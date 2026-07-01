import { describe, it, expect } from "vitest";
import { MAKER_BRIEF, CHECKER_BRIEF, REVIEWER_BRIEF, checkContract, reviewContract, renderBlockers } from "../src/briefs.js";
import { newWorkUnit } from "../src/domain.js";

const unit = newWorkUnit({ projectId: "p", slug: "s", title: "T", spec: "Make foo safe." });

describe("briefs", () => {
  it("maker brief mandates writing the failing test first", () => {
    expect(MAKER_BRIEF.toLowerCase()).toMatch(/failing test first/);
  });

  it("checker + reviewer briefs require the json verdict block", () => {
    expect(CHECKER_BRIEF).toMatch(/```json/);
    expect(REVIEWER_BRIEF).toMatch(/```json/);
  });

  it("maker brief names red-green-refactor", () => {
    expect(MAKER_BRIEF.toLowerCase()).toMatch(/red.*green.*refactor/);
  });

  it("checker brief names the Spec axis", () => {
    expect(CHECKER_BRIEF).toMatch(/Spec axis/);
    expect(CHECKER_BRIEF.toLowerCase()).toMatch(/missing/);
    expect(CHECKER_BRIEF.toLowerCase()).toMatch(/scope creep/);
    expect(CHECKER_BRIEF.toLowerCase()).toMatch(/implemented wrongly/);
    expect(CHECKER_BRIEF.toLowerCase()).toMatch(/quot/);
  });

  it("reviewer brief names the Standards axis and contains the full Fowler smell baseline", () => {
    expect(REVIEWER_BRIEF).toMatch(/Standards axis/);
    const smells = [
      "Mysterious Name",
      "Duplicated Code",
      "Feature Envy",
      "Data Clumps",
      "Primitive Obsession",
      "Repeated Switches",
      "Shotgun Surgery",
      "Divergent Change",
      "Speculative Generality",
      "Message Chains",
      "Middle Man",
      "Refused Bequest",
    ];
    for (const smell of smells) expect(REVIEWER_BRIEF).toMatch(smell);
  });

  it("reviewer brief states the two binding rules", () => {
    expect(REVIEWER_BRIEF.toLowerCase()).toMatch(/repo standards override the baseline/);
    expect(REVIEWER_BRIEF.toLowerCase()).toMatch(/never hard blockers/);
  });

  it("checkContract embeds spec + gate exit code", () => {
    const c = checkContract(unit, { command: "bash health.sh", exitCode: 1, durationMs: 5 });
    expect(c).toMatch(/Make foo safe/);
    expect(c).toMatch(/exit code 1/);
  });

  it("reviewContract embeds spec", () => {
    expect(reviewContract(unit)).toMatch(/Make foo safe/);
  });

  it("renderBlockers lists axis-labeled blockers and gate failure", () => {
    const out = renderBlockers(
      [{ axis: "Spec", verdict: { pass: false, summary: "no", blockers: ["missing guard"], evidence: [] } }],
      { command: "bash health.sh", exitCode: 1, durationMs: 5 });
    expect(out).toMatch(/Previous attempt rejected/);
    expect(out).toMatch(/\[Spec\] missing guard/);
    expect(out).toMatch(/exit code 1/);
  });

  it("renderBlockers merges both axes and skips passing verdicts", () => {
    const out = renderBlockers([
      { axis: "Spec", verdict: { pass: true, summary: "ok", blockers: [], evidence: [] } },
      { axis: "Standards", verdict: { pass: false, summary: "no", blockers: ["duplicated code"], evidence: [] } },
    ]);
    expect(out).not.toMatch(/\[Spec\]/);
    expect(out).toMatch(/\[Standards\] duplicated code/);
  });

  it("renderBlockers with an empty verdict array still surfaces a failed gate (red-gate short-circuit)", () => {
    const out = renderBlockers([], { command: "bash health.sh", exitCode: 1, durationMs: 5, output: "boom" });
    expect(out).toMatch(/Previous attempt rejected/);
    expect(out).toMatch(/exit code 1/);
    expect(out).toMatch(/boom/);
  });
});
