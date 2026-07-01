# Chakravyuh

The ubiquitous language of the owned-loop harness: one hand-seeded work unit driven through a
maker → checker → reviewer cycle until review-ready. This is a glossary, not a spec — definitions say
what a term *is*, not how it is implemented (the code and issue specs own the how).

## Language

### The loop

**Chakravyuh**:
The whole owned loop — one task driven maker → gate → checker → reviewer until it earns the centre
(merged). The system/product name. The *rings* a change passes through are narrative (README), not
glossary terms; the precise terms are the ones below.
_Avoid_: supervisor (the old name), harness (too generic).

**Work unit**:
One backlog spec the loop drives from `pending` to a terminal status. Identity is `projectId:slug`.
_Avoid_: task, ticket, job.

**Backlog**:
The ordered set of work units parsed from one markdown file. The unit of a `--all` drain.
_Avoid_: queue, todo list.

**Maker / Checker / Reviewer**:
The three roles a Pi spawn plays. The maker writes code; the checker verifies the diff read-only
against the **Spec** axis; the reviewer judges independently (different provider) against the
**Standards** axis. Kept distinct so no role grades its own work.
_Avoid_: worker, agent (too generic).

**Gate**:
The deterministic health command whose exit code is the authoritative pass/fail. A model verdict
never overrides it.
_Avoid_: check (overloaded with checker), CI.

**Verdict**:
A checker's or reviewer's structured judgement (`pass`, `summary`, `blockers`, `evidence`) parsed
from a trailing JSON block. `blockers` are the concrete retry feedback.
_Avoid_: result, opinion.

**Leak guard**:
The invariant that the maker's writes land only in its worktree — the target repo root must stay
clean. A dirty root fails the unit. Concurrency-safe as-is: worktrees live outside the root.
_Avoid_: dirty check.

### Parallelism

**Drain**:
Running every non-terminal backlog unit to a terminal status in one `chakravyuh --all` invocation.
_Avoid_: batch, sweep.

**Drain concurrency**:
Running independent units (no dependency edge between them) at the same time, bounded by
`maxParallel`. The outer parallelism axis, owned by Chakravyuh. Distinct from **maker fan-out**.
_Avoid_: parallelism (ambiguous — say which axis).

**Maker fan-out**:
One maker Pi spawn splitting a single large unit across Pi's own subagents. The inner axis, owned by
Pi, out of scope for drain concurrency. The two axes multiply: real peak = `maxParallel` × per-unit
fan-out. `maxParallel` is blind to fan-out, so a project that enables it must keep the cap low.
_Avoid_: subagents (say fan-out to name the axis).

**Verifiers-are-processes** (invariant):
The checker and reviewer must run as separate Pi *processes* with separate context, never as Pi
subagents. Their independence (Condorcet/jury) is what gives a verdict value; a shared subagent
context couples the two verdicts and destroys it. The maker *may* fan out; the verifiers may not.

**Drain lease**:
A single-holder, self-expiring lease in the store that guarantees at most one orchestrator drains a
backlog at a time. Acquired by an atomic compare-and-swap; kept alive by a heartbeat; reclaimable
once the heartbeat goes stale past its TTL. A *lease* (time-bounded, auto-expiring), not a lock.
_Avoid_: lock, mutex, drain-lock.

**Git lock**:
An in-process single-writer mutex serializing every git mutation against the shared common-dir
(`worktree add`, `commit`, `worktree remove`, `branch delete`). Git's own ref/index locks race under
concurrent invocation; the expensive Pi spawns run *outside* this mutex. Coarse by design — git ops
are milliseconds.
_Avoid_: worktree lock (it covers more than worktrees).

**Scheduler-local states**:
A projection over `WorkUnitStatus` used only by the rolling scheduler, never persisted:
*settled* (terminal or already recorded blocked), *in-flight* (running now), *runnable* (all deps
terminal-and-passing, a slot free), *waiting* (a dep still pending/in-flight), *blocked* (a dep
failed or was itself blocked — transitive). Do not add these to the persisted status enum.
_Avoid_: level (there is no level concept — the scheduler is rolling, not barriered).

## Notes

- The store's synchronous single-thread driver serializes DB writes for free within one process; WAL
  is the cross-process margin the **drain lease** relies on. An async DB client would break the
  read-then-write atomicity in `insertRun` and need an explicit transaction.
