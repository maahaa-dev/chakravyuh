import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Project } from "./domain.js";
import type { LoopDeps } from "./loop.js";

const RoleSchema = z.object({ provider: z.string(), model: z.string(), thinking: z.string() });
const ConfigSchema = z.object({
  project: z.object({
    id: z.string(), root: z.string(), worktreeBase: z.string(),
    baseBranch: z.string(), healthCmd: z.string(),
    sandbox: z.boolean().optional().default(true),
    // Bounds concurrent UNITS in `--all`'s parallel drain (see schedule.ts). `1` is the sequential
    // regression guard: same order, same statuses, same exit code as the old plain `for` loop.
    maxParallel: z.number().int().min(1).optional().default(2),
  }),
  roles: z.object({ maker: RoleSchema, checker: RoleSchema, reviewer: RoleSchema }),
  backlogPath: z.string(), dbPath: z.string(), currentMdPath: z.string(), piBinPath: z.string(),
  // Optional per-project budget override. Any omitted field falls back to DEFAULT_BUDGET (see cli.ts).
  // Lets a heavier target (e.g. self-hosting Chakravyuh with capable models) raise the hard/idle
  // timeouts without changing the public default.
  budget: z.object({
    maxAttemptsPerUnit: z.number().int().min(1).optional(),
    idleTimeoutMs: z.number().int().min(1000).optional(),
    hardTimeoutMs: z.number().int().min(1000).optional(),
    maxTokensPerUnit: z.number().int().min(1).optional(),
  }).optional(),
  // Pi extensions (-e) to load on every spawn. Omit to use DEFAULT_EXTENSIONS (empty). [] disables.
  extensions: z.array(z.string()).optional(),
  // Directory for per-run Pi stdout logs (see piLogPath). Must live outside project.root (leak
  // guard) — e.g. loops/<proj>/logs/. Omit to skip logging.
  logDir: z.string().optional(),
});

/**
 * The validated, typed Chakravyuh configuration — one JSON file that wires a project, its per-role
 * model routing, and every filesystem path the loop touches.
 */
export interface ChakravyuhConfig {
  project: Project;
  /**
   * Per-role model routing. The reviewer should differ in provider from the maker/checker so its
   * judgement is genuinely independent.
   */
  roles: LoopDeps["roles"];
  /**
   * Markdown backlog file. Its directory doubles as the control-file dir (`STOP` / `PAUSE`).
   */
  backlogPath: string;
  dbPath: string;
  /**
   * Human-readable status file regenerated after every run.
   */
  currentMdPath: string;
  piBinPath: string;
  /**
   * Optional per-project budget override. Merged over {@link DEFAULT_BUDGET} in the CLI, so any
   * omitted field keeps its default. Use it to give a heavier target more time/attempts without
   * touching the shared default.
   */
  budget?: Partial<LoopDeps["budget"]>;
  /**
   * Pi `-e` extensions loaded on every spawn. Omit to fall back to `DEFAULT_EXTENSIONS` (empty by
   * default); pass `[]` to load none. Configure provider auth per Pi's own docs.
   */
  extensions?: string[];
  /**
   * Directory for per-run Pi stdout logs. Must live outside `project.root` (leak guard) — e.g.
   * `loops/<proj>/logs/`. Omit to skip logging.
   */
  logDir?: string;
}

/**
 * Reads and Zod-validates a config JSON. A malformed shape throws the validation error (fail-fast);
 * path existence is not checked here — the CLI verifies extensions, and bad paths surface as later
 * filesystem errors.
 */
export function loadConfig(path: string): ChakravyuhConfig {
  return ConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
