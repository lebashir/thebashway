import { test, expect } from "bun:test";
import { assertClean } from "../../cleanup";
import type { Runner } from "../types";

const runner = (worktreeOut: string, branchOut: string): Runner => async (cmd) => {
  if (cmd[1] === "worktree") return { code: 0, stdout: worktreeOut, stderr: "" };
  if (cmd[1] === "branch") return { code: 0, stdout: branchOut, stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

test("clean: only the main worktree, no matching branch", async () => {
  const r = await assertClean("build-*", runner("worktree /Users/x/lifeofbash\nHEAD abc\nbranch refs/heads/main\n", ""));
  expect(r.ok).toBe(true);
});

test("fails on a leftover build worktree", async () => {
  const out = "worktree /Users/x/lifeofbash\n\nworktree /Users/x/lifeofbash/.claude/worktrees/build-rest\n";
  const r = await assertClean("build-*", runner(out, ""));
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("stray worktree");
});

test("fails on an orphan branch matching the pattern", async () => {
  const r = await assertClean("build-*", runner("worktree /Users/x/lifeofbash\n", "  build-rest\n"));
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("orphan branch");
});
