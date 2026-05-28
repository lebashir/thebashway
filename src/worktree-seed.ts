// src/worktree-seed.ts
// Copy gitignored files into a freshly-spawned worktree so verify can run.
//
// A fresh `git worktree add` is a clean checkout: it has tracked files only.
// Gitignored files (e.g. `organs/.env.local` carrying Supabase creds) are NOT
// present, so the worktree's `pnpm build` / smoke pass tsc/lint/test but the
// app explodes at runtime ("SUPABASE_URL not set"). The seed list names the
// files a project needs copied; this helper does the copy. The files stay
// gitignored — they're never committed; they just exist in the work path.
//
// Used by the run-mode worktree spawner: after `git worktree add`, the driver
// calls `seedWorktree(workPath, seedPaths)` once. Already-present files are
// left alone (so a re-spawn is idempotent).
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

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
