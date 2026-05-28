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
  /** Repo root (passed as cwd to git/regen commands). */
  cwd: string;
  /** Optional derived-artifact regenerator (e.g. `pnpm gen:home`). */
  regen?: { name: string; cmd: string[] };
  /** Glob pattern for orphan-branch detection (e.g. `wf-*`). */
  branchPattern?: string;
  /** Gitignored files the worktree spawner copies on spawn. */
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
  // Did the regen change anything tracked?
  const status = await run(["git", "status", "--porcelain"], { cwd: surface.cwd });
  if (!status.stdout.trim()) {
    return { name: `preflight:regen:${surface.regen.name}`, ok: true, detail: "no diff" };
  }
  // Commit + push the refresh.
  const add = await run(["git", "add", "-A"], { cwd: surface.cwd });
  if (add.code !== 0) return { name: `preflight:regen:${surface.regen.name}`, ok: false, detail: "git add failed" };
  const commit = await run(
    ["git", "commit", "-m", `chore: refresh derived artifacts (preflight, ${surface.regen.name})`],
    { cwd: surface.cwd },
  );
  if (commit.code !== 0) return { name: `preflight:regen:${surface.regen.name}`, ok: false, detail: "git commit failed" };
  // Push (best-effort; push step also runs unconditionally above for HEAD).
  await run(["git", "push"], { cwd: surface.cwd });
  return { name: `preflight:regen:${surface.regen.name}`, ok: true, detail: "refreshed + committed + pushed" };
}

async function seedExists(surface: PreflightSurface): Promise<CheckResult> {
  const paths = surface.seedPaths ?? [];
  if (paths.length === 0) return { name: "preflight:seeds", ok: true, detail: "no seeds" };
  const missing: string[] = [];
  for (const rel of paths) {
    const abs = rel.startsWith("/") ? rel : `${surface.cwd}/${rel}`;
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
