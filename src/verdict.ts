import { z } from "zod";
import type { GateResult, Verdict } from "./domain.js";

const VerdictSchema = z.object({
  pass: z.boolean(),
  summary: z.string(),
  blockers: z.array(z.string()).default([]),
});

// Case-insensitive on the `json` tag — agents are inconsistent (```json vs ```JSON), and a
// case-mismatched fence would otherwise read as "no verdict json found" and waste an attempt.
const JSON_BLOCK = /```json\s*([\s\S]*?)```/gi;

/**
 * Extracts a role's structured verdict from its free-text output: takes the last ```json``` block,
 * parses and Zod-validates it, and attaches the gate `evidence`. Fail-closed — a missing, malformed,
 * or schema-invalid block yields `pass: false` with a diagnostic blocker rather than throwing, so a
 * garbled agent reply never reads as approval.
 */
export function parseVerdict(text: string, evidence: GateResult[] = []): Verdict {
  const matches = [...text.matchAll(JSON_BLOCK)];
  if (matches.length === 0) {
    return { pass: false, summary: "", blockers: ["no verdict json block found"], evidence };
  }
  const raw = matches[matches.length - 1][1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { pass: false, summary: "", blockers: ["verdict json was malformed"], evidence };
  }
  const result = VerdictSchema.safeParse(parsed);
  if (!result.success) {
    return { pass: false, summary: "", blockers: ["verdict json failed schema"], evidence };
  }
  return { ...result.data, evidence };
}
