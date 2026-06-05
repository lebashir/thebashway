// tools/orchestrator/verify/types.ts
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable process runner — real impl shells out; tests pass a fake. */
export type Runner = (
  cmd: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
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
