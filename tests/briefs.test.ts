import { describe, it, expect } from "vitest";
import { MAKER_BRIEF, CHECKER_BRIEF, REVIEWER_BRIEF, REFLECTOR_BRIEF, checkContract, reviewContract, renderBlockers } from "../src/briefs.js";
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

  it("maker brief discourages redundant re-searching once an answer is already in-session", () => {
    expect(MAKER_BRIEF.toLowerCase()).toMatch(/trivially reworded pattern/);
    expect(MAKER_BRIEF.toLowerCase()).toMatch(/prefer reading a whole relevant file once/);
  });

  it("checker brief names the Spec axis", () => {
    expect(CHECKER_BRIEF).toMatch(/Spec axis/);
    expect(CHECKER_BRIEF.toLowerCase()).toMatch(/missing/);
    expect(CHECKER_BRIEF.toLowerCase()).toMatch(/scope creep/);
    expect(CHECKER_BRIEF.toLowerCase()).toMatch(/implemented wrongly/);
    expect(CHECKER_BRIEF.toLowerCase()).toMatch(/quot/);
  });

  it("checker brief adds category (d) for requirements satisfied but untested", () => {
    expect(CHECKER_BRIEF.toLowerCase()).toMatch(/that no test actually asserts/);
  });

  it("checker brief requires checking every behavioral bullet, not just the Success sentence", () => {
    expect(CHECKER_BRIEF).toMatch(/EVERY behavioral bullet/);
    expect(CHECKER_BRIEF.toLowerCase()).toMatch(/does not waive a requirement/);
  });

  it("checker brief discourages an exhaustive checklist recap of already-satisfied requirements", () => {
    expect(CHECKER_BRIEF.toLowerCase()).toMatch(/do not itemize or restate every already-satisfied requirement/);
    expect(CHECKER_BRIEF.toLowerCase()).toMatch(/terse report naming only genuine findings/);
    expect(CHECKER_BRIEF.toLowerCase()).toMatch(/exhaustive item-by-item recap of the whole spec/);
  });

  it("verdict instruction bounds the summary to one short sentence, not a semicolon-chained recap", () => {
    expect(CHECKER_BRIEF.toLowerCase()).toMatch(/genuinely short sentence \(roughly under 150 characters\)/);
    expect(CHECKER_BRIEF.toLowerCase()).toMatch(/not a semicolon-chained recap of every item/);
    expect(REVIEWER_BRIEF.toLowerCase()).toMatch(/genuinely short sentence \(roughly under 150 characters\)/);
    expect(REVIEWER_BRIEF.toLowerCase()).toMatch(/not a semicolon-chained recap of every item/);
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

  it("reviewer brief states the binding rules, including rule (3) on cross-path consistency", () => {
    expect(REVIEWER_BRIEF.toLowerCase()).toMatch(/repo standards override the baseline/);
    expect(REVIEWER_BRIEF.toLowerCase()).toMatch(/never hard blockers/);
    expect(REVIEWER_BRIEF.toLowerCase()).toMatch(/is not a baseline smell/);
    expect(REVIEWER_BRIEF.toLowerCase()).toMatch(/same weight as a repo-standards violation/);
  });

  it("reviewer brief rule (3) makes cross-path consistency a hard blocker unless justified, rejecting a bare advisory-only dismissal", () => {
    expect(REVIEWER_BRIEF.toLowerCase()).toMatch(/hard blocker \(pass:false\) unless the verdict states a specific/);
    expect(REVIEWER_BRIEF.toLowerCase()).toMatch(/sibling path's invariant does not apply to the new path/);
    expect(REVIEWER_BRIEF.toLowerCase()).toMatch(/"advisory only"/);
    expect(REVIEWER_BRIEF.toLowerCase()).toMatch(/insufficient and must not accompany pass:true/);
  });

  it("reviewer brief adds cross-path consistency to the Standards axis", () => {
    expect(REVIEWER_BRIEF.toLowerCase()).toMatch(/cross-path consistency/);
    expect(REVIEWER_BRIEF.toLowerCase()).toMatch(/sibling path/);
    expect(REVIEWER_BRIEF.toLowerCase()).toMatch(/another cli subcommand/);
    expect(REVIEWER_BRIEF.toLowerCase()).toMatch(/another spawn call/);
  });

  it("reflector brief is read-only/advisory", () => {
    expect(typeof REFLECTOR_BRIEF).toBe("string");
    expect(REFLECTOR_BRIEF.length).toBeGreaterThan(0);
    expect(REFLECTOR_BRIEF.toLowerCase()).toMatch(/read-only/);
    expect(REFLECTOR_BRIEF.toLowerCase()).toMatch(/advisory/);
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
