// src/engine/verify/types.ts
import type { RequiredTouch } from "../../binding";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /**
   * Set true when the run was KILLED for exceeding its `timeoutMs`. A timeout is a
   * FAILURE, never a pass — `evaluateCheckSpec` treats a timed-out command as fail
   * regardless of the resulting exit code. Optional/back-compat: existing runners and
   * fakes omit it (undefined === not-timed-out).
   */
  timedOut?: boolean;
}

/** Injectable process runner — real impl shells out; tests pass a fake. */
export type Runner = (
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
) => Promise<RunResult>;

export interface Check {
  name: string;
  cmd: string[];
}

export interface SurfaceConfig {
  /** Directory the surface lives in, repo-root-relative. */
  dir: string;
  /**
   * The surface's ROLE — the canonical, one-line definition of what belongs here.
   * The feature-design IN door reads this to choose a feature's natural home, so a
   * feature is never reflexively routed into a secondary surface. (Optional: only the
   * design door consumes it.)
   */
  role?: string;
  /** Gate-chain commands, run in order. */
  chain: Check[];
  /** Committed derived artifacts to assert fresh (repo-root-relative paths). */
  derived: string[];
  /** Command that regenerates `derived` (run from `dir`), or null if none. */
  regen: Check | null;
  /** Smoke config (organs only), or null. */
  smoke: { cmd: string[]; portEnv: string; needsBuild: boolean } | null;
  /** Extra env merged into every command for this surface. */
  env?: Record<string, string>;
  /** Needs a real (non-symlinked) install in a worktree before its gate (e.g. Turbopack). */
  needsRealInstall?: boolean;
  /** Build but do NOT auto-deploy on land — stage for human review (e.g. a view a smoke can't exercise). */
  stageNotDeploy?: boolean;
  /** Mechanical "touched too little" completeness rules for this surface (from binding.surfaces[*].requiredTouches).
   *  The verify gate reads these (glob-gated, so cross-surface rules are harmless). Default none. */
  requiredTouches?: RequiredTouch[];
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerifyManifest {
  surface: string;
  baseRef: string;
  head: string;
  territory: string[];
  diffSha256: string;
  outputSha256: string;
  checks: CheckResult[];
  ok: boolean;
  ts: string;
}
