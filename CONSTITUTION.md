# Chakravyuh Constitution

> *Own the loop the way Arjuna knew the chakravyūha — how to enter it, and (unlike Abhimanyu) how to
> get out.* The loop is the formation; these articles are how a change earns its way to the centre.

Why this loop is shaped the way it is. Distilled from Matt Pocock's
([mattpocock/skills](https://github.com/mattpocock/skills)). Every
role the loop runs — planner, maker, checker, reviewer — operates under these articles. When a
change tempts you to violate one, that tension is the signal: stop and resolve it, don't paper over it.

## Article 0 — Own the loop, rent the skills. Keep control.

Frameworks that "own the process" (GSD, BMAD, Spec-Kit) trade your control for their structure, and
when the process has a bug it's their bug, buried in their abstraction. We reject that. Chakravyuh
owns *exactly* the orchestration — maker→checker→reviewer, the gate, state, bounds — and rents
*exactly* the engineering practice as small, composable skills the agent reads directly. Every stage
is legible and every run is logged, so a bug in the process is a bug **you can see and fix**.

Corollary: **the human decomposes and triages; Chakravyuh drains.** A unit reaches the maker only
once a human has marked it `ready-for-agent`. We automate execution, never alignment.

## Article 1 — Alignment before code.

> "No-one knows exactly what they want." — Hunt & Thomas, *The Pragmatic Programmer*

The most common failure is misalignment, not bad code. So we grill before we build. A work unit is
only real when its "done" is stated as a check a machine can run — anything vaguer is a wish, not a
unit. Triage (`ready-for-agent`) is the human's signature that a unit is aligned and specified.

## Article 2 — One shared language.

> "...conversations among developers and expressions of the code are all derived from the same
> domain model." — Eric Evans, *Domain-Driven Design*

Agents dropped into a project use twenty words where one would do. We fix that with a ubiquitous
language: `CONTEXT.md` (the glossary) with `src/domain.ts` as the code-level vocabulary. Every role names domain concepts with the
glossary's terms — in issue titles, test names, hypotheses, code. A concept missing from the glossary
is a signal: either you're inventing language the project doesn't use, or there's a real gap to record.

## Article 3 — The rate of feedback is the speed limit.

> "Always take small, deliberate steps. The rate of feedback is your speed limit." — Hunt & Thomas

An agent without feedback flies blind. So the loop is built around objective feedback the model
cannot talk its way past:

- **The deterministic gate is the boss.** The health command's exit code decides pass/fail *before*
  any LLM verdict counts. No green gate, no approval.
- **Red-green-refactor.** The maker writes the failing test first; the test encodes the unit's "done."
- **Fail closed.** An unparseable or missing verdict is a rejection, never a silent pass.
- **Bounds are external.** Attempts + idle/hard timeout + tokens — the harness imposes the limit the
  model has no incentive to.

## Article 4 — Invest in design every day.

> "Invest in the design of the system *every day*." — Kent Beck, *Extreme Programming Explained*
> "The best modules are deep — a lot of functionality behind a simple interface." — Ousterhout, *APoSD*

Agents accelerate coding, and so they accelerate entropy. We counter it continuously, not in a
big cleanup later: deep modules with small interfaces at clean seams, many small focused files over
few large ones, vertical slices that stand alone, and surgical changes where every edited line traces
to the unit. When a module you touch has grown into a ball of mud, fixing its shape is in scope —
not a someday.

## Article 5 — Match the process to the work.

> "What is the lightest process that still protects quality?"

Not maximum process, not minimum — the intersection. A bug fix and a new feature are not the same
unit. A bug's baseline is *intentionally* red (the failing test is the bug), so **gate-after** is the
safety net and a gate-before would wrongly abort it; a feature expects a clean baseline, so
**gate-before** applies. The unit's `kind` selects its loop depth, its model tier, and which gates
run — per the unit's Work Type Matrix. Over-process burns tokens
and time; under-process ships a ball of mud. Route deliberately, and when real work blows past its
budget, **reclassify** rather than grind.

## Summary

Software engineering fundamentals matter *more* in the agent age, not less. Chakravyuh is a harness
for practicing them at machine speed without losing the plot: align first, speak one language, let
feedback set the pace, design every day, and right-size the process — all while keeping the loop in
your own hands.

## Grounding & sources

These articles distill, and are bound by, the repo's canon. When the canon and an article seem to
conflict, surface it (don't silently override) and reconcile — Article 2.

- **The 12 Principles of LLM-Native Development** by [amuldotexe](https://github.com/amuldotexe)
  ([that-in-rust/agent-room-of-requirements](https://github.com/that-in-rust/agent-room-of-requirements)) —
  the working reference these articles operationalize:
  1. **LLMs are retrieval systems** — the model retrieves against the context you give it; feed it precise names, types, and constraints (Article 2).
  2. **Iteration is required** — the first output is a draft; explore → constrain → refine → verify (Article 3).
  3. **Context windows forget** — long sessions lose earlier decisions, so write summary checkpoints (Article 0's handoff notes).
  4. **Rubber-duck the model** — making it explain and challenge its own work exposes weak reasoning (the checker/reviewer roles).
  5. **Negative knowledge is leverage** — "do not do this" prunes bad paths fast; keep anti-patterns and failure notes.
  6. **Tests are the spec** — executable checks beat prose; write the test before the implementation (Article 3, red-green).
  7. **Four-word names are a strong default** — names shape retrieval quality, so prefer clear, specific, stable ones (Article 2).
  8. **Match process to work type** — a bug and a feature need different rigour; use the lightest process that still protects quality (Article 5).
  9. **PRD and architecture co-evolve** — let design discoveries remove requirements rather than freezing scope up front.
  10. **Serialize state** — progress vanishes without checkpoints; save phase, tests, decisions, and next steps.
  11. **Delegate with rules** — vibes create drift; route work with explicit rules, not intuition (Article 0: automate execution, never alignment).
  12. **Close the loop** — teams improve only by learning from outcomes; record failures, fixes, and wins.
- **The Work Type Matrix** — the lightest-process-that-protects-quality rule that Article 5 enforces.
- Matt Pocock's *Why These Skills Exist* ([mattpocock/skills](https://github.com/mattpocock/skills)) —
  Articles 0–4 (alignment, shared language, feedback loops, deep modules, keep control). Specific skills:
  - `review` — the two-axis verification (**Spec** vs **Standards** + a Fowler smell baseline) the
    checker and reviewer roles enact. Article 3 (verify) + Article 4 (smells = design decay).
  - `decision-mapping` — loose work → a DAG of `Blocked by:` tickets. Grounds dependency-ordered
    drain and the Product/Feature discovery flow. Article 5.
  - `loop-me` — workflow-spec vocabulary: **Trigger / Checkpoint / Brief / push-right**. The human
    checkpoint is pushed as far right as possible and handed a *Brief* (decision-ready, never raw
    output), not asked to babysit. Article 0 (keep control, but respect their time).
- **Own the loop, rent the inner agent** — Chakravyuh owns the orchestration and rents Pi's inner ACI.
