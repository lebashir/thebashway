// src/worktree-seed.ts
// Make a freshly-spawned worktree READY TO BUILD: install deps + copy gitignored
// runtime files.
//
// A fresh `git worktree add` is a clean checkout with TRACKED files only — it has
// NO `node_modules` (gitignored) and NO gitignored runtime files (e.g.
// `organs/.env.local`). Two things are therefore missing before verify can run:
//   1. node_modules — without it tsc/lint/test/build all fail ("cannot find
//      module"). A SYMLINK to the main checkout's node_modules is NOT enough:
//      Turbopack rejects it ("Symlink organs/node_modules is invalid, it points
//      out of the filesystem root"). The worktree needs a REAL node_modules, which
//      `pnpm install --frozen-lockfile --prefer-offline` provides in ~4s on a warm
//      store (mostly hardlinks). See `spawnWorktree`.
//   2. gitignored runtime files (e.g. `organs/.env.local`) — without them build/
//      smoke pass tsc but the app explodes at runtime ("SUPABASE_URL not set").
//      `seedWorktree` copies these; they stay gitignored (never committed).
//
// Use `spawnWorktree` for the full ready-to-build setup (git add + install + seed);
// `seedWorktree` alone is the copy step (idempotent — already-present files are
// left alone).
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

export interface SeedResult {
  copied: string[];
  skipped: string[]; // already present in the worktree (left alone)
  missing: string[]; // source path didn't exist in repo root (logged)
}

/**
 * Copy each seed path from `repoRoot/<path>` to `workPath/<path>`.
 * - Skipped if the destination already exists.
 * - Reported as missing if the source doesn't exist (the driver should treat
 *   this as a preflight failure — the source SHOULD be there).
 */
export async function seedWorktree(
  workPath: string,
  repoRoot: string,
  seedPaths: string[],
): Promise<SeedResult> {
  const copied: string[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];
  for (const rel of seedPaths) {
    const src = join(repoRoot, rel);
    const dst = join(workPath, rel);
    if (!existsSync(src)) {
      missing.push(rel);
      continue;
    }
    if (existsSync(dst)) {
      skipped.push(rel);
      continue;
    }
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    copied.push(rel);
  }
  return { copied, skipped, missing };
}

/** Parse a `preflight-seed.txt` file: one path per line, `#` comments, blanks ignored. */
export function parseSeedList(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

// ---------------------------------------------------------------------------
// spawnWorktree — the full ready-to-build worktree setup
// ---------------------------------------------------------------------------

/** Injectable command runner (so the orchestration is unit-testable). */
export type ExecFn = (cmd: string, args: string[], cwd: string) => void;

const realExec: ExecFn = (cmd, args, cwd) => {
  execFileSync(cmd, args, {
    cwd,
    stdio: "pipe",
    // Tabby machine: pnpm/registry TLS needs this; harmless elsewhere. See
    // memory [[bun-tls-tabby-proxy]].
    env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
  });
};

export interface SpawnResult {
  workPath: string;
  branch: string | null;
  installed: boolean;
  seed: SeedResult;
}

/**
 * Spawn a worktree that is immediately ready for `verify` (including a real
 * Turbopack build). Three steps:
 *   1. `git worktree add [-b <branch>] <workPath> <ref>`
 *   2. `pnpm install --frozen-lockfile --prefer-offline` IN the worktree — a REAL
 *      node_modules (Turbopack rejects a symlinked one). ~4s on a warm store.
 *      Skip with `install: false` for a deps-not-needed worktree.
 *   3. `seedWorktree(...)` to copy gitignored runtime files (e.g. .env.local).
 *
 * `exec` is injectable for tests; the default shells out for real.
 */
export async function spawnWorktree(opts: {
  workPath: string;
  repoRoot: string;
  seedPaths: string[];
  ref?: string;
  branch?: string;
  install?: boolean;
  exec?: ExecFn;
}): Promise<SpawnResult> {
  const { workPath, repoRoot, seedPaths, ref = "HEAD", branch, install = true } = opts;
  const exec = opts.exec ?? realExec;

  const addArgs = branch
    ? ["worktree", "add", "-b", branch, workPath, ref]
    : ["worktree", "add", "--detach", workPath, ref];
  exec("git", addArgs, repoRoot);

  if (install) {
    exec("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], workPath);
  }

  const seed = await seedWorktree(workPath, repoRoot, seedPaths);
  return { workPath, branch: branch ?? null, installed: install, seed };
}
