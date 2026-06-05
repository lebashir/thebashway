// src/preflight.ts
// Run-once session preparation — moves several "I learned this the hard way"
// lessons from per-basha injection into deterministic automation.
//
// Preflight (driver runs it once at the start of a build session, then once
// more if main moves significantly):
//
//   1. push any local commits on the current branch (so worktree bashas
//      branching from origin don't lose them as spurious deletions)
//   2. regenerate the surface's derived artifacts; commit + push if changed
//      (a stale committed snapshot otherwise fails freshness in every
//      basha's verify)
//   3. assert no stray build worktrees / orphan branches
//   4. verify each seed path exists (gitignored files the worktree spawner
//      will copy into fresh worktrees — e.g. organs/.env.local)
//
// Used by `bun run thebashway preflight <surface>` (see run.ts).
import type { Runner, CheckResult } from "./verify/types";
import { bunRun } from "./verify/run";
import { assertClean } from "./cleanup";

export interface PreflightSurface {
  /** Surface name (logged). */
  name: string;
  /** Surface's working directory (passed as cwd to git/regen commands run
   *  against that surface — typically `${repoRoot}/${dir}`). */
  cwd: string;
  /** Repo root — used to resolve `seedPaths` (which are repo-root-relative,
   *  matching `worktree-seed.ts`). Defaults to `cwd` for back-compat with
   *  surfaces whose cwd IS the repo root. */
  repoRoot?: string;
  /** Optional derived-artifact regenerator (e.g. `pnpm gen:home`). */
  regen?: { name: string; cmd: string[] };
  /** Derived artifact paths (repo-root-relative) the regen step produces. The
   *  regen commit stages ONLY these — never `git add -A`, which would sweep
   *  unrelated uncommitted work into the "refresh derived artifacts" commit. */
  derived?: string[];
  /** Glob pattern for orphan-branch detection (e.g. `wf-*`). */
  branchPattern?: string;
  /** Gitignored files the worktree spawner copies on spawn.
   *  Paths are repo-root-relative (resolved against `repoRoot`, falling
   *  back to `cwd`). */
  seedPaths?: string[];
}

export interface PreflightResult {
  ok: boolean;
  checks: CheckResult[];
}

async function pushCurrentBranch(cwd: string, run: Runner): Promise<CheckResult> {
  const head = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  const branch = head.stdout.trim();
  if (!branch || branch === "HEAD") {
    return { name: "preflight:push", ok: true, detail: "detached HEAD; skip" };
  }
  // Probe whether the branch has an upstream; if not, set one to origin.
  const upstream = await run(["git", "rev-parse", "--abbrev-ref", `${branch}@{upstream}`], { cwd });
  const args = upstream.code === 0
    ? ["git", "push"]
    : ["git", "push", "-u", "origin", branch];
  const r = await run(args, { cwd });
  return {
    name: "preflight:push",
    ok: r.code === 0,
    detail: r.code === 0
      ? `pushed ${branch}`
      : `push ${branch} failed: ${r.stderr.trim().split("\n").slice(-3).join(" | ")}`,
  };
}

async function regenAndCommit(
  surface: PreflightSurface,
  run: Runner,
): Promise<CheckResult> {
  if (!surface.regen) return { name: "preflight:regen", ok: true, detail: "no regen configured" };
  const r = await run(surface.regen.cmd, { cwd: surface.cwd });
  if (r.code !== 0) {
    return {
      name: `preflight:regen:${surface.regen.name}`,
      ok: false,
      detail: r.stderr.trim().split("\n").slice(-3).join(" | "),
    };
  }
  // Stage ONLY the declared derived artifacts — never `git add -A`, which would
  // sweep unrelated uncommitted work into the refresh commit. Derived paths are
  // repo-root-relative, so run git from the repo root.
  const root = surface.repoRoot ?? surface.cwd;
  const derived = surface.derived ?? [];
  if (derived.length === 0) {
    return { name: `preflight:regen:${surface.regen.name}`, ok: true, detail: "regen ran; no derived paths declared to commit" };
  }
  // Did the regen change any DERIVED artifact specifically?
  const status = await run(["git", "status", "--porcelain", "--", ...derived], { cwd: root });
  if (!status.stdout.trim()) {
    return { name: `preflight:regen:${surface.regen.name}`, ok: true, detail: "no diff" };
  }
  // Commit + push the refresh (derived paths only).
  const add = await run(["git", "add", "--", ...derived], { cwd: root });
  if (add.code !== 0) return { name: `preflight:regen:${surface.regen.name}`, ok: false, detail: "git add failed" };
  const commit = await run(
    ["git", "commit", "-m", `chore: refresh derived artifacts (preflight, ${surface.regen.name})`],
    { cwd: root },
  );
  if (commit.code !== 0) return { name: `preflight:regen:${surface.regen.name}`, ok: false, detail: "git commit failed" };
  // Push (best-effort; push step also runs unconditionally above for HEAD).
  await run(["git", "push"], { cwd: root });
  return { name: `preflight:regen:${surface.regen.name}`, ok: true, detail: "refreshed + committed + pushed" };
}

async function seedExists(surface: PreflightSurface): Promise<CheckResult> {
  const paths = surface.seedPaths ?? [];
  if (paths.length === 0) return { name: "preflight:seeds", ok: true, detail: "no seeds" };
  // Seed paths are repo-root-relative (same convention as worktree-seed.ts,
  // which resolves them against the repo root when copying into a fresh
  // worktree). Fall back to `cwd` if `repoRoot` is not provided.
  const base = surface.repoRoot ?? surface.cwd;
  const missing: string[] = [];
  for (const rel of paths) {
    const abs = rel.startsWith("/") ? rel : `${base}/${rel}`;
    const f = Bun.file(abs);
    if (!(await f.exists())) missing.push(rel);
  }
  return {
    name: "preflight:seeds",
    ok: missing.length === 0,
    detail: missing.length === 0
      ? `${paths.length} seed path(s) present`
      : `missing: ${missing.join(", ")}`,
  };
}

export async function preflight(
  surface: PreflightSurface,
  run: Runner = bunRun,
): Promise<PreflightResult> {
  // Order matters: regen FIRST (it might commit), THEN push, THEN cleanup, THEN seeds.
  // If we pushed first we'd push without the refresh.
  const regen = await regenAndCommit(surface, run);
  const push = await pushCurrentBranch(surface.cwd, run);
  const clean = await assertClean(surface.branchPattern ?? "tighten-*", run);
  const seeds = await seedExists(surface);
  const checks = [regen, push, clean, seeds];
  return { ok: checks.every((c) => c.ok), checks };
}
