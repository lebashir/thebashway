import { test, expect } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../../verify/types";
import { preflight, type PreflightSurface } from "../../preflight";

function fakeRunner(handlers: Record<string, { code: number; stdout?: string; stderr?: string }>): Runner {
  return async (cmd) => {
    const key = cmd.join(" ");
    // Match the first handler key that the cmd starts with.
    for (const [k, v] of Object.entries(handlers)) {
      if (key === k || key.startsWith(k + " ")) {
        return { code: v.code, stdout: v.stdout ?? "", stderr: v.stderr ?? "" };
      }
    }
    // Default to a clean ok for any other call (git push, etc.).
    return { code: 0, stdout: "", stderr: "" };
  };
}

test("preflight: all checks ok when push succeeds + no regen + clean + seeds present", async () => {
  const repo = await mkdtemp(join(tmpdir(), "preflight-"));
  await writeFile(join(repo, "seed.txt"), "stub\n");
  const surface: PreflightSurface = {
    name: "test",
    cwd: repo,
    branchPattern: "no-such-pattern-*",
    seedPaths: ["seed.txt"],
  };
  const run = fakeRunner({
    "git rev-parse --abbrev-ref HEAD": { code: 0, stdout: "main\n" },
    "git rev-parse --abbrev-ref main@{upstream}": { code: 0, stdout: "origin/main\n" },
    "git worktree list --porcelain": { code: 0, stdout: "worktree /repo\n" },
    "git branch --list": { code: 0, stdout: "" },
  });
  const r = await preflight(surface, run);
  expect(r.ok).toBe(true);
  expect(r.checks.find((c) => c.name === "preflight:push")?.ok).toBe(true);
  expect(r.checks.find((c) => c.name === "preflight:seeds")?.ok).toBe(true);
  rmSync(repo, { recursive: true });
});

test("preflight: seeds check fails when a declared seed is missing", async () => {
  const repo = await mkdtemp(join(tmpdir(), "preflight-"));
  const surface: PreflightSurface = {
    name: "test",
    cwd: repo,
    branchPattern: "no-such-pattern-*",
    seedPaths: ["does/not/exist"],
  };
  const run = fakeRunner({
    "git rev-parse --abbrev-ref HEAD": { code: 0, stdout: "main\n" },
    "git rev-parse --abbrev-ref main@{upstream}": { code: 0, stdout: "origin/main\n" },
    "git worktree list --porcelain": { code: 0, stdout: "worktree /repo\n" },
    "git branch --list": { code: 0, stdout: "" },
  });
  const r = await preflight(surface, run);
  expect(r.ok).toBe(false);
  expect(r.checks.find((c) => c.name === "preflight:seeds")?.detail).toContain("does/not/exist");
  rmSync(repo, { recursive: true });
});

test("preflight: regen running but producing no diff reports `no diff`, does not commit", async () => {
  const repo = await mkdtemp(join(tmpdir(), "preflight-"));
  const surface: PreflightSurface = {
    name: "organs",
    cwd: repo,
    regen: { name: "gen:home", cmd: ["pnpm", "gen:home"] },
    branchPattern: "no-such-pattern-*",
  };
  const calls: string[] = [];
  const run: Runner = async (cmd) => {
    const key = cmd.join(" ");
    calls.push(key);
    if (key === "pnpm gen:home") return { code: 0, stdout: "", stderr: "" };
    if (key === "git status --porcelain") return { code: 0, stdout: "", stderr: "" };
    if (key === "git rev-parse --abbrev-ref HEAD") return { code: 0, stdout: "main\n", stderr: "" };
    if (key === "git rev-parse --abbrev-ref main@{upstream}") return { code: 0, stdout: "origin/main\n", stderr: "" };
    if (key === "git worktree list --porcelain") return { code: 0, stdout: "worktree /repo\n", stderr: "" };
    if (key === "git branch --list no-such-pattern-*") return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const r = await preflight(surface, run);
  expect(r.ok).toBe(true);
  const regen = r.checks.find((c) => c.name === "preflight:regen:gen:home");
  expect(regen?.detail).toBe("no diff");
  // Should NOT have called git commit.
  expect(calls.some((c) => c.startsWith("git commit"))).toBe(false);
  rmSync(repo, { recursive: true });
});
