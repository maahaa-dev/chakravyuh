# Reflection Pass — Design

**Date:** 2026-07-02
**Status:** Approved (design); pending spec review before planning
**Origin:** Meta-Harness paper (Lee et al., 2026) comparison — item 2 ("self-improving reflection pass"). The paper's thesis: harness quality (what a system stores, retrieves, and shows the model) drives large performance gaps, and text optimizers fail when they *compress feedback too aggressively* before the optimizer sees it. Chakravyuh already has the two prerequisites the paper needs — a deterministic scoring gate and a raw trace store — plus, now, working self-hosting.

## Goal

Add an **advisory, human-gated reflection pass**: a read-only command that reads Chakravyuh's own raw run traces and outcomes, then proposes concrete improvements to the harness's prompt surface (`briefs.ts`), with rationale. The human accepts a proposal, which becomes a normal backlog unit that the existing self-host loop implements and its own gate + verifiers validate.

This takes the paper's *trace-rich advisory* core while deliberately **not** taking its *fully-autonomous benchmark-chasing* — that is bounded by the constitution (Article 0: own the loop; Article 5: no unconstrained prompt search).

## Decisions (locked)

1. **Genotype = briefs only (v1).** The reflector may propose edits only to `briefs.ts` prose: `MAKER_BRIEF`, `CHECKER_BRIEF`, `REVIEWER_BRIEF`, `FOWLER_SMELL_BASELINE`, `REVIEWER_BINDING_RULES`, `VERDICT_INSTRUCTION`, and the contract builders. Role model-routing and budgets stay hand-set. Rationale: smallest, most legible surface; the paper locates most leverage in prompt/feedback quality; keeps blast radius tiny.
2. **Advisory command, not an autonomous loop.** Reflection produces a *document*, never a diff or a commit. The human is the accept gate; the existing self-host loop is the apply-and-validate mechanism.

## Architecture

Three small, independently testable units. All reflection I/O is read-only over the store and logs; nothing touches a worktree, the gate, or git.

| Unit | Purpose | Reads | Writes |
|------|---------|-------|--------|
| `reflect.ts` — `buildReflectionInput(units, runs, logDir)` | **Pure.** Fold store rows + per-run log paths + per-unit outcomes into a scored trace digest object. | in-memory `WorkUnit[]`, `Run[]`, `logDir` path | nothing (returns data) |
| `REFLECTOR_BRIEF` (in `briefs.ts`) | System prompt for the reflector role: read the digest + raw logs, find harness weaknesses, propose specific `briefs.ts` edits with rationale, and draft a ready-to-paste backlog unit. Read-only; forbidden from editing. | — | — |
| `reflect` CLI subcommand | Thin wiring: load store → `buildReflectionInput` → spawn reflector (read-only tools, pinned Pi + extension) → save its output as a proposal markdown. | `config.json` | `loops/<proj>/reflections/<ts>.md` |

### Component detail

- **`buildReflectionInput` (pure):** derives, per unit, the scoring signal below and pairs each run with its `logDir` stdout log path so the reflector can `cat`/`grep` the un-compressed trace itself (the paper's key move — do not pre-summarize). Returns a plain object; no I/O, no spawning. This is the unit that carries the logic and the tests.
- **Reflector role:** spawned with the same pinned runner and `anthropic-subscription` extension as maker/checker/reviewer, tools `read,grep,find,ls`, no worktree, no sandbox mutation. Its final message *is* the proposal document (same "final text is the return value" contract the other roles use).
- **`reflect` subcommand:** mirrors the existing `status` / `sync-status` subcommand shape in `cli.ts`. `chakravyuh reflect <config.json> [--last N]` (default N = a small window, e.g. 20 most-recent units by run recency). Read-only over the store; writes only under `loops/<proj>/reflections/`.

## Data flow

```
runs + work_units (SQLite)  ─┐
per-run stdout logs (logDir) ─┼─►  buildReflectionInput  ─►  scored trace digest
                             ─┘                                    │
                                                                   ▼
                                    spawn reflector (Claude, read-only) reads digest + raw logs
                                                                   │
                                                                   ▼
                              loops/<proj>/reflections/<ts>.md  (observations + proposed
                              briefs.ts edits + rationale + a draft backlog unit)
                                                                   │
                                          human reviews & accepts  ▼
                              paste draft unit into backlog.md  ─►  self-host loop implements
                              the briefs.ts edit  ─►  gate + checker + reviewer validate  ─►  branch
```

## Scoring signal (derived; no new schema)

Computed by `buildReflectionInput` from existing rows only:

- **Outcome** per unit: `approved` / `failed` / `blocked`.
- **Attempts-to-approve:** the unit's terminal `attempt`.
- **Tokens-to-approve:** Σ (`tokensIn + tokensOut`) across the unit's runs — also the missing **tokens-per-approval** efficiency metric, surfaced here for the first time.
- **Verifier reject reasons:** the `blockers` arrays from each attempt's `verdict_json` (checker = Spec axis, reviewer = Standards axis), so the reflector sees *why* attempts were rejected, not just that they were.

The reflector receives these plus the raw log paths, so it reasons over un-compressed traces rather than a distilled summary.

## Human gate & overfitting guard

- The proposal is inert markdown; it changes nothing until a human acts.
- Accepted proposals flow through the **existing** loop: a backlog unit edits `briefs.ts`, and the loop's own gate + checker + reviewer validate the change on real work. The apply-and-validate path is already built and dogfooded.
- **Overfitting guard (v1):** the human chooses which real units run next, so there is no single benchmark to overfit, and no formal held-out set is required yet. If a future version ever lets reflection drive itself (Approach C), a held-out task set becomes mandatory — noted as out-of-scope below.

## Testing

- `buildReflectionInput` is pure → unit-tested with fake `WorkUnit[]` / `Run[]`: scoring math (attempts, token sums, reject-reason extraction), digest shape, and correct log-path pairing. This is where coverage concentrates.
- `reflect` CLI wiring → tested like existing subcommands (arg parsing, read-only store access, output path under `reflections/`), with a fake spawn.
- Reflector output is non-deterministic → asserted only structurally ("writes a file containing the required sections"), never on content.

## Out of scope (v1)

- Autonomous outer search / auto-apply (Approach C).
- Proposing edits to `config.roles` or `DEFAULT_BUDGET` (genotype is briefs-only for v1).
- A formal held-out benchmark task set (only needed if reflection ever self-drives).
- Any change to the drain loop, gate, or git handling.

## Open questions

- Default `--last N` window size (start ~20, tune from real use).
- Whether the proposal template should hard-require a "draft backlog unit" section or leave it optional when the reflector finds nothing worth changing (lean: always emit a section, allowing "no change recommended").
