import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parsePiStream } from "../src/pi-parse.js";

// Real Pi `--mode json` stdout emits a stream of `message` events (no `agent_end`).
// Each assistant turn in the tool-loop carries its own usage; tokens must be summed.
const msgLines = readFileSync(new URL("./fixtures/pi-messages.jsonl", import.meta.url), "utf8")
  .split("\n").filter(Boolean);

describe("parsePiStream — robustness", () => {
  it("ignores non-JSON / blank lines without throwing", () => {
    expect(() => parsePiStream([...msgLines, "", "not json"])).not.toThrow();
  });

  it("returns stopReason undefined before any assistant message arrives", () => {
    expect(parsePiStream([msgLines[0]]).stopReason).toBeUndefined();
  });
});

describe("parsePiStream — real message-event stream", () => {
  it("captures session id from the session header", () => {
    expect(parsePiStream(msgLines).sessionId).toBe("sess-msg-1");
  });

  it("SUMS tokens across every assistant turn (not just the last)", () => {
    const r = parsePiStream(msgLines);
    expect(r.tokensOut).toBe(261); // 119 + 106 + 36
    expect(r.tokensIn).toBe(5); //   3 +   1 +  1
  });

  it("takes stopReason + text from the final assistant message", () => {
    const r = parsePiStream(msgLines);
    expect(r.stopReason).toBe("stop");
    expect(r.text).toMatch(/"pass":true/);
  });

  it("maps a non-terminal final stopReason (toolUse) to a non-stop value", () => {
    const truncated = msgLines.slice(0, 5); // ends on an assistant toolUse turn
    expect(parsePiStream(truncated).stopReason).not.toBe("stop");
  });
});

describe("parsePiStream — verdict survives a trailing turn", () => {
  // The verdict json block can be emitted before the agent's final turn (e.g. it adds a closing
  // "Done." turn after the verdict). Text must ACCUMULATE across turns, or parseVerdict sees no
  // json block and the run wastes an attempt on a false "no verdict json found".
  const turn = (text: string, stopReason = "stop") => JSON.stringify({
    type: "message_end",
    message: { role: "assistant", usage: { input: 1, output: 1 }, stopReason, content: [{ type: "text", text }] },
  });

  it("keeps an earlier turn's verdict text when the final turn has none", () => {
    const lines = [
      turn('Here is my verdict:\n```json\n{"pass":true,"summary":"ok","blockers":[]}\n```'),
      turn("Done."),
    ];
    expect(parsePiStream(lines).text).toMatch(/"pass":true/);
  });

  it("still reflects the final turn's stopReason", () => {
    const lines = [turn("verdict", "stop"), turn("trailing", "aborted")];
    expect(parsePiStream(lines).stopReason).toBe("aborted");
  });
});
