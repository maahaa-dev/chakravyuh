import type { Run } from "./domain.js";

interface ParseResult {
  sessionId?: string;
  stopReason?: Run["stopReason"];
  tokensIn: number;
  tokensOut: number;
  text: string;
}

// Pi stopReasons we store verbatim; anything else (e.g. "toolUse" from a truncated
// tool-loop) is an incomplete run -> normalize to "error" so it never reads as "stop".
const TERMINAL = new Set(["stop", "error", "aborted", "timeout"]);

function textOf(message: any): string {
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((b: any) => b?.type === "text").map((b: any) => b.text ?? "").join("");
}

function normalizeStop(raw: unknown): Run["stopReason"] | undefined {
  if (typeof raw !== "string") return undefined;
  return (TERMINAL.has(raw) ? raw : "error") as Run["stopReason"];
}

// Fold one assistant message into the running result: sum its usage, let the latest turn win
// stopReason, and ACCUMULATE text across turns. Accumulating (not last-turn-wins) is load-bearing:
// the verdict ```json block may be emitted before a trailing turn (e.g. a closing "Done."), and
// keeping only the last turn's text would drop it — parseVerdict would then see no block and waste
// an attempt on a false "no verdict json found". parseVerdict still takes the LAST block, so the
// final verdict wins wherever in the transcript it was emitted.
function foldAssistant(result: ParseResult, message: any): void {
  if (message?.role !== "assistant") return;
  result.tokensIn += message.usage?.input ?? 0;
  result.tokensOut += message.usage?.output ?? 0;
  result.stopReason = normalizeStop(message.stopReason) ?? "stop";
  const t = textOf(message);
  if (t) result.text = result.text ? `${result.text}\n${t}` : t;
}

/**
 * Reduces Pi's `--mode json --print` stdout — a stream of granular JSON events — into one
 * {@link ParseResult}. Token usage is summed across every `message_end` turn (each assistant turn
 * carries its own usage, so reading only the last turn undercounts to ~0); the last turn wins the
 * stopReason and text. Streaming partials are ignored.
 *
 * @note Parses the STDOUT event shape (`message_end`), not the on-disk session-log shape
 * (`{type:"message"}`) — Chakravyuh captures stdout.
 */
export function parsePiStream(lines: string[]): ParseResult {
  const result: ParseResult = { tokensIn: 0, tokensOut: 0, text: "" };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === "session") {
      result.sessionId = event.id;
    } else if (event.type === "message_end") {
      foldAssistant(result, event.message);
    }
  }
  return result;
}
