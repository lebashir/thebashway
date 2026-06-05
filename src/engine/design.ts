// tools/orchestrator/design.ts
// The feature-design IN door: pure data contracts + the DETERMINISTIC safety gates the
// design runner applies before any task becomes build-ready. All pure (no fs, no spawn) —
// unit-tested. See design-run.ts for the pipeline that wires these to real bashas + drain,
// and docs/superpowers/specs/2026-06-05-thebashway-feature-design-door.md for the why.
//
// Why these gates live in tested code, not prose: the OUT door's "park anything that
// reaches a real person or destroys unrecoverable data" rail is only SKILL/decisions text
// an interactive driver honors — there is no such code in drain.ts. The design door
// removes that human driver, so it re-adds the rail HERE, deterministically.
import { z } from "zod";
import { SURFACES, DESIGN_IRREVERSIBLE } from "./config";
import { CompletableItemSchema, type CompletableItem } from "./audit";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** The Design stage's output: the feature designed on its own merits, with its natural
 * home chosen from the surface roles — never reflexively organs. */
export const FeatureDesignSchema = z.object({
  /** The natural home, chosen from surface ROLES (never defaults to organs). */
  surface: z.enum(["organs", "tools"]),
  /** Why this surface — must justify organs if chosen (it is the secondary view). */
  surfaceRationale: z.string().min(1),
  /** The feature's name (also the decomposition's dedup root). */
  title: z.string().min(1),
  /** What it is + the approach, grounded in what already exists in the repo. */
  summary: z.string().min(1),
  /** Genuine ambiguities only a human can resolve ([] is the goal). */
  openQuestions: z.array(z.string()).default([]),
});
export type FeatureDesign = z.infer<typeof FeatureDesignSchema>;

/** The Decompose stage's output: a list of completable tasks (the shared audit item
 * schema, which already carries dependsOn / reachesPeople / destructive). */
export const DecompositionSchema = z.array(CompletableItemSchema);

/** One per-task verdict from the cold review of the design + task list. */
export const TaskVerdictSchema = z.object({
  index: z.number().int().min(0),
  buildReady: z.boolean(),
  reason: z.string().optional(),
});
export type TaskVerdict = z.infer<typeof TaskVerdictSchema>;

/** The cold review of the DESIGN and the TASK LIST (the v1 gap was reviewing only the
 * design). `designVerdict: "revise"` bounces the Design stage once; `taskVerdicts` flag
 * which tasks the fresh reviewer does NOT trust to be build-ready. */
export const DesignReviewSchema = z.object({
  designVerdict: z.enum(["approve", "revise"]),
  /** What the design must fix when designVerdict = "revise". */
  required: z.array(z.string()).default([]),
  /** Per-task build-ready judgement, aligned by task index. */
  taskVerdicts: z.array(TaskVerdictSchema).default([]),
});
export type DesignReview = z.infer<typeof DesignReviewSchema>;

// ---------------------------------------------------------------------------
// Surface roles (read by the Design/Decompose prompts)
// ---------------------------------------------------------------------------

/**
 * The canonical surface ROLES, rendered for a prompt. The Design stage reads this so it
 * routes a feature to its natural home and never defaults to organs. Sourced from
 * SURFACES[*].role (config.ts) — change the definition there, not here.
 */
export function surfaceRoles(): string {
  return Object.entries(SURFACES)
    .filter(([, cfg]) => cfg.role)
    .map(([name, cfg]) => `- ${name}: ${cfg.role}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Gate 1 — irreversible / person-reaching (the linchpin)
// ---------------------------------------------------------------------------

/** The base directory prefix of a glob: everything up to the first wildcard segment.
 * "tools/google/**" -> "tools/google"; "tools/jobs/x.ts" -> "tools/jobs/x.ts". */
function globBase(glob: string): string {
  const out: string[] = [];
  for (const seg of glob.split("/")) {
    if (seg.includes("*")) break;
    out.push(seg);
  }
  return out.join("/");
}

/** Path-prefix OVERLAP between two globs (by base prefix): equal, or one base is a path
 * ancestor of the other. So a broad territory that CONTAINS a sensitive dir is caught,
 * and a sensitive dir glob catches a narrower territory inside it. An empty base (a bare
 * "**") overlaps everything — treated as overlap (fail safe). */
export function pathsOverlap(a: string, b: string): boolean {
  const ba = globBase(a);
  const bb = globBase(b);
  if (!ba || !bb) return true;
  return ba === bb || ba.startsWith(bb + "/") || bb.startsWith(ba + "/");
}

/**
 * TRUE if a task must be forced @needs-intake because it reaches a real person or destroys
 * unrecoverable data. Three independent nets (any hit parks): (1) the decompose basha's
 * own reachesPeople/destructive flags; (2) the keyword net over title+goal+doneWhen (the
 * description of such a feature names it); (3) a territory that overlaps an all-sensitive
 * directory (e.g. tools/google). This is NEVER overridden by freeze-authorization — the
 * typed `design` command authorizes new UI, not reaching people or destroying data.
 */
export function classifyIrreversible(
  item: Pick<CompletableItem, "title" | "goal" | "doneWhen" | "territory" | "reachesPeople" | "destructive">,
): boolean {
  if (item.reachesPeople || item.destructive) return true;
  const text = `${item.title} ${item.goal} ${item.doneWhen}`;
  if (DESIGN_IRREVERSIBLE.keywords.test(text)) return true;
  for (const t of item.territory) {
    // The keyword net over the territory PATH (a path naming send/email/telegram/… trips
    // even when the task's prose is neutral — the send-rail-with-bland-wording case).
    if (DESIGN_IRREVERSIBLE.keywords.test(t)) return true;
    for (const deny of DESIGN_IRREVERSIBLE.territoryGlobs) {
      if (pathsOverlap(t, deny)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Gate 2 — surface match (single-surface drain; a mismatch is silently un-claimable)
// ---------------------------------------------------------------------------

/**
 * Indices of tasks whose territory does NOT lie entirely within the run's surface dir.
 * A single `drain` runs one surface's verify config and `claim` only returns items whose
 * every glob is under that surface dir — so a mismatched item enqueues but is never
 * claimed (a silent done-0). The runner forces these @needs-intake + reports them.
 */
export function validateSurface(
  items: Pick<CompletableItem, "territory">[],
  surface: "organs" | "tools",
): number[] {
  const dir = SURFACES[surface]?.dir ?? surface;
  const prefix = `${dir}/`;
  const bad: number[] = [];
  items.forEach((item, i) => {
    const allUnder = item.territory.length > 0 && item.territory.every((t) => t.startsWith(prefix));
    if (!allUnder) bad.push(i);
  });
  return bad;
}

// ---------------------------------------------------------------------------
// Gate 3 — dependency-graph integrity (dangling + cyclic)
// ---------------------------------------------------------------------------

/**
 * Validate the dependsOn graph the decompose basha emitted, BY TITLE. `isClaimable`
 * treats a dep whose title is not found as satisfied ("missing dep is a no-op"), so a
 * typo'd / drifted dependency would silently let a dependent build out of order. Returns
 * the indices of tasks that must be forced @needs-intake:
 *   - dangling: a dependsOn title that matches no sibling in the batch.
 *   - cyclic:   a task that participates in a dependency cycle (would deadlock — both
 *               permanently unclaimable — with no signal).
 */
export function validateDepGraph(
  items: Pick<CompletableItem, "title" | "dependsOn">[],
): { dangling: number[]; cyclic: number[] } {
  const titleToIndex = new Map<string, number>();
  items.forEach((it, i) => titleToIndex.set(it.title, i));

  const dangling: number[] = [];
  items.forEach((it, i) => {
    for (const dep of it.dependsOn ?? []) {
      if (!titleToIndex.has(dep)) {
        dangling.push(i);
        break;
      }
    }
  });

  // Cycle detection over the resolvable edges (DFS three-color).
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Array(items.length).fill(WHITE);
  const inCycle = new Set<number>();

  const visit = (i: number, stack: number[]): void => {
    color[i] = GRAY;
    stack.push(i);
    const node = items[i];
    for (const dep of node?.dependsOn ?? []) {
      const j = titleToIndex.get(dep);
      if (j === undefined) continue; // dangling handled above
      if (color[j] === GRAY) {
        // Back-edge → cycle: every node from j to the top of the stack is in it.
        const start = stack.indexOf(j);
        for (let k = start; k < stack.length; k++) {
          const node = stack[k];
          if (node !== undefined) inCycle.add(node);
        }
      } else if (color[j] === WHITE) {
        visit(j, stack);
      }
    }
    stack.pop();
    color[i] = BLACK;
  };

  for (let i = 0; i < items.length; i++) {
    if (color[i] === WHITE) visit(i, []);
  }

  return { dangling: [...new Set(dangling)], cyclic: [...inCycle].sort((a, b) => a - b) };
}

// ---------------------------------------------------------------------------
// Gate 4 — unique titles (title is the queue's identity for claim/markDone/dependsOn)
// ---------------------------------------------------------------------------

/**
 * Indices of tasks whose title is NOT unique within the batch. A title is the queue's
 * identity: drain's markDone/markBlocked resolve `items.find(i => i.title === title)`
 * (first match), `dependsOn` references a title, and the runner's atomic-landing guard
 * checks title membership in `drain.succeeded`. Duplicate titles therefore collapse all
 * three — most dangerously, a single success can satisfy two same-titled build-ready
 * members and land a half-built feature. The runner forces every duplicate-titled task to
 * @needs-intake (a decompose error a human must resolve), so a duplicate can never be
 * build-ready.
 */
export function findDuplicateTitleIndices(items: Pick<CompletableItem, "title">[]): number[] {
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.title, (counts.get(it.title) ?? 0) + 1);
  const out: number[] = [];
  items.forEach((it, i) => {
    if ((counts.get(it.title) ?? 0) > 1) out.push(i);
  });
  return out;
}
