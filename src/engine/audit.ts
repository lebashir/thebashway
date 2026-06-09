// tools/orchestrator/audit.ts
// Directed-audit IN door: target resolution + canonicalized fingerprint +
// Zod schemas for the audit pipeline's data contracts.
//
// resolveTarget(target) -> AuditPlan
//   Maps a human target ("money", a path-like string, a glob) to an AuditPlan
//   that lists the fan-out sub-areas for finder bashas.
//   - Known targets: look up AUDIT_TARGETS registry (config.ts).
//   - Generic fallback: split a directory path into its immediate .ts/.tsx
//     files + immediate subdirectories, capped at AUDIT_FANOUT_MAX.
//   - Unknown / empty target: throws a clear error (never silently dispatches
//     zero finders).
//
// auditFingerprint(item) -> string
//   "audit:<sha1-8>" over canonicalized title + territory (sorted+trimmed+
//   lowercased, title collapsed like normalizeMarkerText). Prefix "audit:"
//   keeps it distinct from "todo:" and "wrapup:" fingerprints.
//
// All pure (no fs); unit-tested.
import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizeMarkerText } from "./capture-sweep";
import { AUDIT_TARGETS, AUDIT_FANOUT_MAX, SURFACES, getDefaultSurface, getRepoRoot } from "./config";

// ---------------------------------------------------------------------------
// Zod schemas + inferred types
// ---------------------------------------------------------------------------

export const AuditPlanSchema = z.object({
  /** Which project surface this target belongs to (a key in the binding's surfaces). */
  surface: z.string().min(1),
  /** The root glob that covers the whole target area. */
  rootGlob: z.string().min(1),
  /** Fan-out partitions for finder bashas (capped at AUDIT_FANOUT_MAX). */
  subAreas: z.array(z.string().min(1)).min(1).max(AUDIT_FANOUT_MAX),
});
export type AuditPlan = z.infer<typeof AuditPlanSchema>;

export const FindingSchema = z.object({
  /** Short human title for the defect found. */
  title: z.string().min(1),
  /** Detailed description: what is wrong and where. */
  description: z.string().min(1),
  /** The sub-area (glob) this finding came from. */
  subArea: z.string().min(1),
  /** Confidence that this is a real defect (0-1). */
  confidence: z.number().min(0).max(1),
  /** Whether the fix is safe inside the existing freeze policy (no new organ UI). */
  freezeSafe: z.boolean(),
  /** Finder kind: omitted/undefined = a correctness defect (default); "design" = a
   * design-quality / design-system deviation from the design finder. Design findings are
   * ADVISORY — runAudit forces them @needs-intake (taste is human-gated). The design-finder
   * prompt MUST emit "kind":"design" or it is treated as correctness. */
  kind: z.enum(["correctness", "design"]).optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

/** The status values the shaping stage may assign to a completable item.
 * Only "unclaimed" (build-ready) and "needs-intake" (requires human input). */
const CompletableStatusSchema = z.enum(["unclaimed", "needs-intake"]);

export const CompletableItemSchema = z.object({
  /** Item title (concise, will be deduped via fingerprint). */
  title: z.string().min(1),
  /** What this item produces / its goal. */
  goal: z.string().min(1),
  /** Glob list — the files the fix may touch (sufficient for completability). */
  territory: z.array(z.string().min(1)).min(1),
  /** Exit criterion. */
  doneWhen: z.string().min(1),
  /** "unclaimed" = build-ready; "needs-intake" = needs human before drain. */
  status: CompletableStatusSchema,
  /** Unresolved question that keeps the item @needs-intake. Required when
   * status="needs-intake" and there is an open question. */
  openQuestion: z.string().optional(),
  /** false = new organ UI or other frozen area. For AUDIT items this forces
   * @needs-intake; for an explicitly-authorized DESIGN run the runner may pass
   * freezeAuthorized to allow it (see effectiveQueueStatus). */
  freezeSafe: z.boolean(),
  /** Titles of sibling tasks that must finish first — feature-design dependency chains
   * (migration → read/actions → UI). Validated against the batch by the design runner
   * (a dangling title would otherwise degrade to "no dependency" in isClaimable). */
  dependsOn: z.array(z.string().min(1)).optional(),
  /** Design-decompose flag: the task sends to / reaches a real person. The design
   * runner's classifyIrreversible forces such a task @needs-intake regardless of
   * freeze-authorization (the typed command authorizes new UI, not reaching people). */
  reachesPeople: z.boolean().optional(),
  /** Design-decompose flag: the task deletes / destroys unrecoverable data. Forced
   * @needs-intake by the same gate. */
  destructive: z.boolean().optional(),
  /** Stamped by runAudit when the source finding was a design finding. Carries design provenance
   * through shaping; runAudit also forces such items @needs-intake deterministically (not trusting
   * the LLM's freezeSafe). undefined = a normal correctness/build item. */
  kind: z.enum(["correctness", "design"]).optional(),
});
export type CompletableItem = z.infer<typeof CompletableItemSchema>;

/**
 * The single source of truth for a completable item's effective queue status.
 * A finding is build-ready (`@unclaimed`) ONLY when it is freeze-safe, carries no
 * open question, and the shaper chose `unclaimed`; anything else is forced to
 * `@needs-intake` (a human must look before a drain can claim it). Reused by
 * `enqueueFindings` (the write), `cmdEnqueueFindings` (the report counts), and the
 * `audit` runner — so the rule can never desync across the three.
 */
export function effectiveQueueStatus(
  item: Pick<CompletableItem, "freezeSafe" | "openQuestion" | "status">,
  opts?: { freezeAuthorized?: boolean },
): "unclaimed" | "needs-intake" {
  // An open question always wins (it is also how the irreversible/person-data gate and the
  // surface/dep-graph guards force a task to wait — see design-run.ts §5).
  if (item.openQuestion) return "needs-intake";
  // Not freeze-safe (new organs UI / frozen area): forced @needs-intake UNLESS the caller
  // is an interactively-kicked design run that carries the human's freeze authorization.
  // `freezeAuthorized` is invocation-bound (the runner passes it; never an LLM field).
  if (!item.freezeSafe && !opts?.freezeAuthorized) return "needs-intake";
  return item.status;
}

// ---------------------------------------------------------------------------
// Canonicalized fingerprint
// ---------------------------------------------------------------------------

/**
 * Canonical fingerprint for a completable item.
 * Hash input: normalizeMarkerText(title) + "|" + sorted+trimmed+lowercased territory globs.
 * Prefix "audit:" (distinct from "todo:" / "wrapup:").
 */
export function auditFingerprint(item: Pick<CompletableItem, "title" | "territory">): string {
  const normalizedTitle = normalizeMarkerText(item.title);
  const sortedGlobs = [...item.territory]
    .map((g) => g.trim().toLowerCase())
    .sort()
    .join(",");
  const raw = `${normalizedTitle}|${sortedGlobs}`;
  const h = createHash("sha1").update(raw).digest("hex").slice(0, 8);
  return `audit:${h}`;
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/**
 * Infer the surface ("organs" | "tools") from a root glob or a path segment.
 * Falls back to "organs" for anything not obviously "tools".
 */
function inferSurface(path: string): string {
  // Pick the surface whose `dir` is the longest path-prefix of `path`. A surface
  // with dir "." (whole repo) is the lowest-priority catch-all. If nothing matches,
  // fall back to the binding's defaultSurface.
  let best: string | null = null;
  let bestLen = -1;
  for (const [name, cfg] of Object.entries(SURFACES)) {
    const dir = (cfg as { dir: string }).dir;
    const isMatch = dir === "." ? true : path === dir || path.startsWith(dir + "/");
    const len = dir === "." ? 0 : dir.length;
    if (isMatch && len > bestLen) {
      best = name;
      bestLen = len;
    }
  }
  return best ?? getDefaultSurface();
}

// The repository root comes from the injected binding (getRepoRoot), so audits read
// the TARGET repo's directories, not this package's.

/**
 * Resolve a human target string to an AuditPlan.
 *
 * Lookup order:
 *   1. AUDIT_TARGETS registry (exact key match, case-insensitive).
 *   2. Generic dir-split fallback: target treated as a repo-relative dir path.
 *   3. Unknown: throw a clear error naming the target.
 *
 * Never returns an empty subAreas array (would silently dispatch zero finders).
 */
export function resolveTarget(target: string): AuditPlan {
  const trimmed = target.trim();
  if (!trimmed) {
    throw new Error(
      `resolveTarget: target must not be empty. Pass a registry key (e.g. "money") ` +
        `or a repo-relative directory path.`,
    );
  }

  // 0. Whole-repo target: "." → audit the default surface.
  if (trimmed === "." || trimmed === "./") {
    const surface = getDefaultSurface();
    const dir = SURFACES[surface]?.dir ?? ".";
    return AuditPlanSchema.parse({
      surface,
      rootGlob: dir === "." ? "**" : `${dir}/**`,
      subAreas: genericSubAreasSync(dir),
    });
  }

  // 1. Registry lookup (case-insensitive).
  const lower = trimmed.toLowerCase();
  const registryEntry = AUDIT_TARGETS[lower] ?? AUDIT_TARGETS[trimmed];
  if (registryEntry) {
    return AuditPlanSchema.parse(registryEntry);
  }

  // 1b. Surface-name target: audit the whole of a configured surface BY NAME (e.g. "engine",
  //     "tools"). A bare surface name is not ".", not a registry key, and (for a root surface,
  //     dir ".") not a path with "/", so it would otherwise hit the throw below — but run-to-goal's
  //     work-bridge legitimately targets a failing criterion's surface by name.
  const surfaceCfg = SURFACES[trimmed];
  if (surfaceCfg) {
    const dir = surfaceCfg.dir;
    return AuditPlanSchema.parse({
      surface: trimmed,
      rootGlob: dir === "." ? "**" : `${dir}/**`,
      subAreas: genericSubAreasSync(dir),
    });
  }

  // 2. Directory target: a path containing "/", OR a bare name that is an existing
  //    directory in the repo (so `fix lib` works, not only `fix lib/foo`). Trailing
  //    slashes are stripped so `fix lib/` never yields a `lib//**` glob.
  const cleaned = trimmed.replace(/\/+$/, "");
  const isExistingDir = (() => {
    try {
      const { existsSync, statSync } = require("node:fs") as typeof import("node:fs");
      const abs = `${getRepoRoot()}/${cleaned}`;
      return existsSync(abs) && statSync(abs).isDirectory();
    } catch {
      return false;
    }
  })();
  if (cleaned.includes("/") || isExistingDir) {
    const surface = inferSurface(cleaned);
    return AuditPlanSchema.parse({
      surface,
      rootGlob: `${cleaned}/**`,
      subAreas: genericSubAreasSync(cleaned),
    });
  }

  // 3. Unknown key (no "/" → not a path, not in registry).
  throw new Error(
    `resolveTarget: cannot resolve target "${trimmed}". ` +
      `Known registry targets: ${Object.keys(AUDIT_TARGETS).join(", ")}. ` +
      `To use a directory, pass a repo-relative path containing "/" ` +
      `(e.g. "organs/src/sections/people").`,
  );
}

/** Synchronous version of genericSubAreas for the pure resolveTarget API. */
function genericSubAreasSync(rootPath: string): string[] {
  const isRoot = rootPath === "." || rootPath === "" || rootPath === "./";
  const abs = isRoot ? getRepoRoot() : `${getRepoRoot()}/${rootPath}`;
  const prefix = isRoot ? "" : `${rootPath}/`;
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const entries = readdirSync(abs, { withFileTypes: true });
    const dirEntries: string[] = [];
    for (const e of entries) {
      // Skip dependency + hidden dirs so a whole-repo audit never fans out into node_modules.
      if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) {
        dirEntries.push(`${prefix}${e.name}/**`);
      }
    }
    const hasLooseFiles = entries.some(
      (e) => e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".tsx")),
    );
    if (hasLooseFiles) dirEntries.push(`${prefix}*.{ts,tsx}`);
    if (dirEntries.length === 0) return [isRoot ? "**" : `${rootPath}/**`];
    return dirEntries.slice(0, AUDIT_FANOUT_MAX);
  } catch {
    return [isRoot ? "**" : `${rootPath}/**`];
  }
}
