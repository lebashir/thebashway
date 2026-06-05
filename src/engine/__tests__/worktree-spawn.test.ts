import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWorktree, type ExecFn } from "../worktree-seed";

// spawnWorktree orchestrates git + pnpm + the seed copy. We inject a fake exec
// to assert the command SEQUENCE without touching real git/pnpm, and use a real
// temp dir for the seed-copy half.

function setup() {
  const repoRoot = mkdtempSync(join(tmpdir(), "spawn-repo-"));
  const workPath = mkdtempSync(join(tmpdir(), "spawn-wt-"));
  // a gitignored runtime file in the repo root to be seeded
  mkdirSync(join(repoRoot, "organs"), { recursive: true });
  writeFileSync(join(repoRoot, "organs", ".env.local"), "SUPABASE_URL=x\n");
  const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
  const exec: ExecFn = (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd });
  };
  return { repoRoot, workPath, calls, exec };
}

test("spawnWorktree: detached add, then install IN the worktree, then seed", async () => {
  const { repoRoot, workPath, calls, exec } = setup();
  const res = await spawnWorktree({
    workPath,
    repoRoot,
    seedPaths: ["organs/.env.local"],
    exec,
  });

  // git worktree add --detach <workPath> HEAD, run from repoRoot
  expect(calls[0]).toEqual({
    cmd: "git",
    args: ["worktree", "add", "--detach", workPath, "HEAD"],
    cwd: repoRoot,
  });
  // pnpm install (frozen + offline) run IN the worktree (real node_modules — a
  // symlink is rejected by Turbopack)
  expect(calls[1]).toEqual({
    cmd: "pnpm",
    args: ["install", "--frozen-lockfile", "--prefer-offline"],
    cwd: workPath,
  });
  expect(res.installed).toBe(true);
  expect(res.branch).toBeNull();
  // seed copied the gitignored runtime file
  expect(existsSync(join(workPath, "organs", ".env.local"))).toBe(true);
  expect(readFileSync(join(workPath, "organs", ".env.local"), "utf8")).toContain("SUPABASE_URL");
  expect(res.seed.copied).toContain("organs/.env.local");

  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(workPath, { recursive: true, force: true });
});

test("spawnWorktree: branch + ref are honored; install can be skipped", async () => {
  const { repoRoot, workPath, calls, exec } = setup();
  await spawnWorktree({
    workPath,
    repoRoot,
    seedPaths: [],
    ref: "main",
    branch: "tbw/x",
    install: false,
    exec,
  });

  expect(calls[0]).toEqual({
    cmd: "git",
    args: ["worktree", "add", "-b", "tbw/x", workPath, "main"],
    cwd: repoRoot,
  });
  // install skipped → only the git call ran
  expect(calls.length).toBe(1);

  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(workPath, { recursive: true, force: true });
});
