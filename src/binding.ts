// src/binding.ts
// The ProjectBinding contract — the ONE file a project supplies to teach the engine
// about itself. Everything the engine used to hardcode for lifeofbash (surfaces,
// audit targets, rails, sinks, learning stores) now arrives through this typed shape.
// A project writes a `thebashway.config.ts` that calls defineThebashway({...}); the
// CLI loads it and hands the result to the engine. See README + USAGE.

import type { Notify, EventSink, StatusFile } from "./sinks";

/** One command in a surface's verify chain. Non-zero exit = the gate fails. */
export interface VerifyCheck {
  name: string;
  cmd: string[];
  env?: Record<string, string>;
}

/** A prod-render smoke test on an ephemeral port. null = skip (most surfaces). */
export interface SmokeConfig {
  cmd: string[];
  portEnv: string;
  needsBuild: boolean;
}

/** A command that regenerates committed/derived artifacts (checked by the freshness gate). */
export interface RegenConfig {
  name: string;
  cmd: string[];
}

/** A mechanical completeness rule: when a change matches whenGlob, require a change matching requireGlob. */
export interface RequiredTouch {
  name: string;
  whenStatus: Array<"A" | "M" | "D">;
  whenGlob: string;
  requireGlob: string;
  message: string;
}

/** A buildable area of the repo. The verify chain is the CODE evidence gate. */
export interface SurfaceBinding {
  /** Path from repoRoot. */
  dir: string;
  /** Prose read by Build Mode to choose this surface's natural home. */
  role: string;
  /** The code gate, run in order. */
  chain: VerifyCheck[];
  /** Paths kept in sync by the freshness gate (default none). */
  derived?: string[];
  /** Command that regenerates `derived` (null = none). */
  regen?: RegenConfig | null;
  /** Prod-render smoke (null = skip). */
  smoke?: SmokeConfig | null;
  /** Extra env applied to this surface's commands. */
  env?: Record<string, string>;
  /** Completeness rules for this surface (default none). */
  requiredTouches?: RequiredTouch[];
  /** Needs a real (non-symlinked) install in a worktree before its gate runs (e.g. Turbopack). Default false. */
  needsRealInstall?: boolean;
  /** Build but do NOT auto-deploy on land — stage for human review (e.g. a web view a smoke can't exercise). Default false. */
  stageNotDeploy?: boolean;
}

/** A registered audit target: the IN-door fan-out partitions for Fix Mode. */
export interface AuditTargetBinding {
  surface: string;
  rootGlob: string;
  subAreas: string[];
}

/** Stage-2 capture-sweep binding (optional). */
export interface SweepBinding {
  scanGlobs: string[];
  excludeGlobs: string[];
  markerRegex: RegExp;
  wrapUpGlobs: string[];
  wrapUpSignal: RegExp;
  maxPerSweep: number;
  backlogWarnAt: number;
}

/** The park rail: tasks reaching people or destroying data are forced to human review. */
export interface RailsBinding {
  territoryGlobs: string[];
  keywords: RegExp;
  /** How aggressively classifyDrift flags a designed feature that contradicts the brief's
   *  core scope. 'off' = kill switch. Default 'medium'. Resolved in the defineThebashway spread. */
  briefDriftSensitivity?: "off" | "low" | "medium" | "high";
}

/** Hybrid learning stores. global is shared/cross-project (read); local is this repo's (read+write). */
export interface LearningBinding {
  global?: string | null;
  local: string;
  decisions: string;
  /** The per-project design brief (north star). Path from repoRoot. Default `.thebashway/brief.ts`.
   *  Resolved-with-default in the defineThebashway spread (NOT the throw guard). */
  brief?: string;
}

export interface SinkBinding {
  notify?: Notify;
  eventSink?: EventSink;
  statusFile?: StatusFile;
}

export interface ProjectBinding {
  /** Absolute path to the repo root. `init` fills this in. */
  repoRoot: string;
  surfaces: Record<string, SurfaceBinding>;
  /** Ambiguous Build-Mode features land here (never reflexively a "view" surface). Must be a surface key. */
  defaultSurface: string;
  auditTargets?: Record<string, AuditTargetBinding>;
  sweep?: SweepBinding;
  rails: RailsBinding;
  learning: LearningBinding;
  sinks?: SinkBinding;
  breaker?: { maxFailures: number; window: number };
  maxConcurrent?: number;
  branchPattern?: string;
  seedPaths?: string[];
}

/** Filled-in binding: optional fields resolved to their defaults. */
export type ResolvedBinding = ProjectBinding &
  Required<Pick<ProjectBinding, "breaker" | "maxConcurrent" | "branchPattern" | "seedPaths">>;

/**
 * Validate a binding and resolve its defaults. Throws on a structural mistake a
 * project author could plausibly make (no surfaces, a defaultSurface or audit-target
 * surface that names no real surface).
 */
export function defineThebashway(b: ProjectBinding): ResolvedBinding {
  if (!b.surfaces || Object.keys(b.surfaces).length === 0) {
    throw new Error("binding: at least one surface is required");
  }
  if (!b.surfaces[b.defaultSurface]) {
    throw new Error(
      `binding: defaultSurface "${b.defaultSurface}" is not one of the surfaces (${Object.keys(b.surfaces).join(", ")})`,
    );
  }
  for (const [name, t] of Object.entries(b.auditTargets ?? {})) {
    if (!b.surfaces[t.surface]) {
      throw new Error(`binding: auditTarget "${name}" names surface "${t.surface}" which is not a surface key`);
    }
  }
  if (!b.learning?.local || !b.learning?.decisions) {
    throw new Error("binding: learning.local and learning.decisions paths are required");
  }
  return {
    branchPattern: "tbw/*",
    breaker: { maxFailures: 2, window: 3 },
    maxConcurrent: 6,
    seedPaths: [],
    ...b,
    // Resolve the brief defaults AFTER ...b so they win, in this single resolution site
    // (never the :140 throw guard). Optional-with-default preserves back-compat.
    learning: { ...b.learning, brief: b.learning.brief ?? ".thebashway/brief.ts" },
    rails: { ...b.rails, briefDriftSensitivity: b.rails.briefDriftSensitivity ?? "medium" },
  };
}
