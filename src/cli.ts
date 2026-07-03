/**
 * The `chakravyuh` CLI — the one user-facing entrypoint. Loads and validates a config, verifies the
 * configured Pi extensions exist, selects a backlog unit (by `--unit <slug>` or the first), and runs
 * it through {@link runUnit} with all real dependencies wired in. Idempotent: a unit already
 * `approved`/`done` is skipped without re-spending tokens.
 *
 * Usage: `chakravyuh <config.json> [--unit <slug>] [--list] [--all] [status]`. `--list` prints
 * `<slug>\t<title>` for every backlog unit and exits 0 without spawning Pi or running the loop.
 * `status` prints {@link renderStatus} over every stored unit/run and exits 0, read-only over the
 * store — it also counts markdown files under `loops/<project>/reflections/` and passes that count
 * in as `renderStatus`'s `pendingReflections` arg, so an accepted-but-unreviewed reflection
 * proposal (design doc, decision 3) is visible without being modeled as a `WorkUnit`. `--all` drains every
 * non-terminal unit (see {@link unitsToDrain}) through the same single-unit path, ordered so a
 * unit runs after everything its spec's `Blocked by:`/`deps:` line names (see {@link drainOrder}),
 * but no longer strictly sequential: {@link scheduleStep} (`schedule.ts`) rolls units with no
 * dependency edge between them forward concurrently, bounded by `project.maxParallel` (default 2;
 * `1` is behaviourally identical to the old sequential drain). A unit whose dependency ended
 * `failed` (or was itself skipped) is skipped as `blocked`, transitively, never attempted on a
 * broken base. A cross-process {@link acquireDrainLease} (SQLite `drain_lock` row) ensures only one
 * `--all` drains a given store at a time — a second concurrent drain exits `2`. Prints a
 * {@link drainSummary}; it is a usage error combined with `--unit`.
 * Exit codes: `0` approved or already-terminal (or, with `--all`, no unit ended `failed`); `1` a
 * non-approved result or no matching unit; `2` a usage error (no config, `--unit` without a slug,
 * `--unit` with `--all`, a missing extension, or another `--all` already draining this store).
 *
 * `chakravyuh sync-status <featureDir> <config.json>` is a separate, explicit, human-run subcommand
 * (see {@link syncStatus}) — it rewrites each `<featureDir>/issues/*.md` file's `Status:` line from
 * the store's latest terminal run status and exits 0. It is never invoked from the drain loop.
 *
 * `chakravyuh reflect <config.json> [--last N]` is a third explicit, human-run, advisory subcommand
 * (see the reflection-pass design doc): read-only over the store, it loads the `N` most-recently-
 * updated units (default {@link DEFAULT_REFLECT_LAST}) plus every run, folds them into a scored
 * trace digest via {@link buildReflectionInput}, and spawns exactly ONE read-only reflector role
 * (tools `read,grep,find,ls`, `REFLECTOR_BRIEF`) via {@link runReflect} — no worktree, no health
 * gate, no git, no commit. The reflector's final text is written verbatim to
 * `<reflections>/<ISO-timestamp>.md` (same `reflections/` dir the `status` branch above counts),
 * the only thing this subcommand writes. Exits 0 on success.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadConfig } from "./config.js";
import { parseBacklog } from "./store/backlog-md.js";
import { listUnitsText } from "./list.js";
import { SqliteStore } from "./store/sqlite-store.js";
import { spawnPi, DEFAULT_EXTENSIONS } from "./pi.js";
import { firstMissingExtension } from "./extensions.js";
import { runHealth } from "./gates.js";
import { addWorktree, removeWorktree, deleteBranch, rootIsClean, commitAll, isPathInside } from "./git.js";
import { runUnit } from "./loop.js";
import { DEFAULT_BUDGET, type WorkUnit, type WorkUnitStatus } from "./domain.js";
import { unitsToDrain, drainSummary } from "./drain.js";
import { drainOrder } from "./deps.js";
import { scheduleStep } from "./schedule.js";
import { acquireDrainLease, DrainLeaseHeldError, type DrainLease } from "./lease.js";
import { renderStatus } from "./status.js";
import { syncStatus } from "./sync-status.js";
import { buildReflectionInput, runReflect, DEFAULT_REFLECT_LAST } from "./reflect.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // `sync-status` is an explicit, human-run, outside-the-loop subcommand (no leak guard — it's not
  // a maker run) — never wired into the drain loop. Takes its own positional args, not <config.json>
  // first like every other subcommand.
  if (args[0] === "sync-status") {
    const [, featureDir, syncConfigPath] = args;
    if (!featureDir || !syncConfigPath) {
      console.error("usage: chakravyuh sync-status <featureDir> <config.json>");
      process.exit(2);
    }
    const syncCfg = loadConfig(syncConfigPath);
    const store = new SqliteStore(syncCfg.dbPath);
    const result = syncStatus(featureDir, store, syncCfg.project.id);
    store.close();
    for (const c of result.changes) console.log(`${c.slug}: ${c.from} -> ${c.to}`);
    for (const f of result.noStatusLine) console.log(`${f}: no Status: line, left untouched`);
    process.exit(0);
  }

  // `reflect` is another explicit, human-run, outside-the-loop subcommand — advisory and read-only
  // over the store (see the reflection-pass design doc). It never touches a worktree, the health
  // gate, or git, and writes only under `<reflections>/<ISO-timestamp>.md`, derived next to
  // backlogPath the same way the `status` branch below derives it.
  if (args[0] === "reflect") {
    const [, reflectConfigPath, ...reflectRest] = args;
    if (!reflectConfigPath) {
      console.error("usage: chakravyuh reflect <config.json> [--last N]");
      process.exit(2);
    }
    const lastIdx = reflectRest.indexOf("--last");
    const lastN = lastIdx >= 0 ? Number(reflectRest[lastIdx + 1]) : DEFAULT_REFLECT_LAST;
    if (lastIdx >= 0 && (!reflectRest[lastIdx + 1] || Number.isNaN(lastN))) {
      console.error("--last requires a numeric argument");
      process.exit(2);
    }

    const reflectCfg = loadConfig(reflectConfigPath);
    const reflectStore = new SqliteStore(reflectCfg.dbPath);
    const units = reflectStore.allUnits().slice(0, lastN); // allUnits() is newest-first by updated_at
    const runs = reflectStore.allRuns();
    reflectStore.close();

    const reflectLogDir = reflectCfg.logDir ?? join(dirname(reflectCfg.backlogPath), "logs");
    const digest = buildReflectionInput(units, runs, reflectLogDir);
    const reflectionsDir = join(dirname(reflectCfg.backlogPath), "reflections");

    // Fail loudly at startup if a configured Pi extension path is missing — same check and same
    // message/exit code as the main drain path below, so a dropped path never surfaces later as an
    // opaque per-spawn error.
    const reflectExtensions = reflectCfg.extensions ?? DEFAULT_EXTENSIONS;
    const missingReflectExt = firstMissingExtension(reflectExtensions);
    if (missingReflectExt) { console.error(`extension not found: ${missingReflectExt}`); process.exit(2); }

    const path = await runReflect(spawnPi, digest, reflectionsDir, {
      provider: reflectCfg.roles.reviewer.provider,
      model: reflectCfg.roles.reviewer.model,
      thinking: reflectCfg.roles.reviewer.thinking,
      piBinPath: reflectCfg.piBinPath,
      extensions: reflectExtensions,
      idleTimeoutMs: DEFAULT_BUDGET.idleTimeoutMs,
      hardTimeoutMs: DEFAULT_BUDGET.hardTimeoutMs,
    });
    console.log(`reflection written to ${path}`);
    process.exit(0);
  }

  const [configPath, ...rest] = args;
  if (!configPath) { console.error("usage: chakravyuh <config.json> [--unit <slug>] [--list] [--all]"); process.exit(2); }
  const unitFlagIdx = rest.indexOf("--unit");
  const wantedSlug = unitFlagIdx >= 0 ? rest[unitFlagIdx + 1] : undefined;
  if (unitFlagIdx >= 0 && !rest[unitFlagIdx + 1]) {
    console.error("--unit requires a slug argument");
    process.exit(2);
  }
  const all = rest.includes("--all");
  if (all && wantedSlug) {
    console.error("--all cannot be combined with --unit");
    process.exit(2);
  }

  const cfg = loadConfig(configPath);

  if (rest[0] === "status") {
    const store = new SqliteStore(cfg.dbPath);
    // Reflection proposals live in loops/<project>/reflections/ (sibling of backlog.md) and are
    // deliberately never WorkUnits (design doc, decision 3) — renderStatus stays pure, so the CLI
    // does the directory read and passes just the count in.
    const reflectionsDir = join(dirname(cfg.backlogPath), "reflections");
    const pendingReflections = existsSync(reflectionsDir)
      ? readdirSync(reflectionsDir).filter((f) => f.endsWith(".md")).length
      : 0;
    console.log(renderStatus(store.allUnits(), store.allRuns(), pendingReflections));
    store.close();
    process.exit(0);
  }

  if (rest.includes("--list")) {
    const backlog = parseBacklog(readFileSync(cfg.backlogPath, "utf8"), cfg.project.id);
    console.log(listUnitsText(backlog));
    process.exit(0);
  }

  // Fail loudly at startup if a configured Pi extension path is missing, so a dropped path surfaces
  // here rather than later as a per-request spawn error.
  const extensions = cfg.extensions ?? DEFAULT_EXTENSIONS;
  const missingExt = firstMissingExtension(extensions);
  if (missingExt) { console.error(`extension not found: ${missingExt}`); process.exit(2); }

  const backlog = parseBacklog(readFileSync(cfg.backlogPath, "utf8"), cfg.project.id);

  const store = new SqliteStore(cfg.dbPath);

  // Control files live in loops/<project>/ alongside the backlog (per design), so derive their
  // paths from backlogPath — NOT from project.root, which need not be a sibling of loops/.
  const projectControlDir = dirname(cfg.backlogPath); // .../loops/<project>
  const stopFile = join(projectControlDir, "..", "STOP"); // .../loops/STOP
  const pauseFile = join(projectControlDir, "PAUSE"); //     .../loops/<project>/PAUSE
  const stopRequested = () => existsSync(stopFile) || existsSync(pauseFile);

  // Per-run Pi stdout logs live alongside the backlog, NOT under project.root (leak guard) —
  // same derivation as the control files above. cfg.logDir overrides when set.
  const logDir = cfg.logDir ?? join(projectControlDir, "logs"); // .../loops/<project>/logs
  // Enforce the leak-guard invariant the tee's JSDoc only documented: a logDir inside project.root
  // would be written during the maker run and trip rootIsClean, failing the unit for a log file
  // rather than maker output. Fail fast with a clear message instead.
  if (isPathInside(logDir, cfg.project.root)) {
    console.error(`logDir ${logDir} is inside project.root ${cfg.project.root} — would trip the leak guard; set logDir outside the target repo`);
    process.exit(2);
  }

  // Runs one unit through the loop, honouring the same already-terminal skip the single-unit path
  // has always had. Shared by both the single-unit and `--all` branches below.
  async function runOne(unit: WorkUnit): Promise<{ slug: string; status: WorkUnitStatus; attempt: number }> {
    // Skip units already in a terminal state — re-running an approved unit wastes a full token
    // spend and (via addWorktree) risks resetting its kept branch. Identity is project+slug
    // (deterministic id), so the prior run's status is found here.
    const prior = store.getWorkUnit(unit.id);
    if (prior && (prior.status === "approved" || prior.status === "done")) {
      console.log(`unit ${unit.slug} already ${prior.status}; skipping`);
      return { slug: unit.slug, status: prior.status, attempt: prior.attempt };
    }
    store.upsertWorkUnit(unit);

    const result = await runUnit(cfg.project, unit, {
      store, spawn: spawnPi, runHealth, addWorktree, removeWorktree, deleteBranch,
      rootIsClean, commitAll, stopRequested, roles: cfg.roles,
      budget: { ...DEFAULT_BUDGET, ...cfg.budget },
      piBinPath: cfg.piBinPath, sandbox: cfg.project.sandbox, extensions, logDir,
    });
    console.log(`unit ${result.slug} -> ${result.status} (attempt ${result.attempt})`);
    return result;
  }

  if (all) {
    // Ordered so a unit that consumes another's output (a `Blocked by:`/`deps:` line in its spec)
    // always runs after it; throws on a cycle rather than looping. A unit whose dependency ended
    // `failed` (or was itself skipped as `blocked`) is skipped as `blocked` too, transitively,
    // instead of running on a broken base. scheduleStep (schedule.ts) drives a rolling, cap-bounded
    // parallel drain instead of a plain sequential `for`: `maxParallel` (project config, default 2)
    // bounds concurrent units; `cap: 1` walks `queue` one at a time in the same order with the same
    // statuses and exit code as the old sequential loop (the regression guard).
    const queue = drainOrder(unitsToDrain(backlog));
    const cap = cfg.project.maxParallel ?? 2;

    // Typed (not inferred `any`) and initialized to `undefined` up front so the `finally` below can
    // safely no-op (`lease?.release()`) in the structurally-unreachable case of acquireDrainLease
    // throwing something other than DrainLeaseHeldError — defense in depth, not load-bearing: today
    // that throw always happens before this variable's scope even opens its own try/finally.
    let lease: DrainLease | undefined;
    try {
      lease = acquireDrainLease(store);
    } catch (e) {
      if (e instanceof DrainLeaseHeldError) {
        console.error(e.message);
        store.close();
        process.exit(2);
      }
      throw e;
    }

    const statuses = new Map<string, WorkUnitStatus>();
    const inFlight = new Map<string, Promise<void>>();

    // STOP/PAUSE mid-drain: stop starting new units (checked each tick, below); units already
    // running self-halt to `blocked` via runOne -> runUnit's own `stopRequested()` checks (no
    // hard-kill, worktrees preserved). SIGINT/SIGTERM does the same and guarantees the lease is
    // freed even if the process is asked to exit while units are still in flight.
    let interrupted = false;
    const onSignal = (): void => { interrupted = true; };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    try {
      for (;;) {
        if (!stopRequested() && !interrupted) {
          const step = scheduleStep(queue, statuses, new Set(inFlight.keys()), cap);
          for (const u of step.block) {
            console.log(`unit ${u.slug} blocked: dependency failed or blocked`);
            statuses.set(u.slug, "blocked");
          }
          for (const u of step.start) {
            inFlight.set(
              u.slug,
              runOne(u).then((result) => {
                statuses.set(result.slug, result.status);
                inFlight.delete(u.slug);
              }),
            );
          }
        }
        if (inFlight.size === 0) break; // nothing running, and (unless stopping) nothing left to start
        await Promise.race(inFlight.values());
      }
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      lease?.release();
    }

    const results = queue.map((u) => ({ slug: u.slug, status: statuses.get(u.slug) }))
      .filter((r): r is { slug: string; status: WorkUnitStatus } => r.status !== undefined);
    store.regenerateCurrentMd(cfg.currentMdPath, cfg.project.id);
    store.close();
    console.log(drainSummary(results));
    process.exit(results.some((r) => r.status === "failed") ? 1 : 0);
  }

  const unit = wantedSlug ? backlog.find((u) => u.slug === wantedSlug) : backlog[0];
  if (!unit) {
    store.close();
    console.error(`no work unit${wantedSlug ? ` matching ${wantedSlug}` : ""}`);
    process.exit(1);
  }

  const result = await runOne(unit);
  store.regenerateCurrentMd(cfg.currentMdPath, cfg.project.id);
  store.close();
  process.exit(result.status === "approved" || result.status === "done" ? 0 : 1);
}

main();
