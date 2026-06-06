// tools/orchestrator/cleanup.ts
// Leave-no-trace, ASSERTED (rule 6). After a unit's worktree teardown, the driver
// confirms the property — no leftover build worktree, no orphan branch matching
// the unit pattern — rather than trusting that teardown happened.
import type { CheckResult, Runner } from "./verify/types";
import { bunRun, parseNameOnly } from "./verify/run";

export async function assertClean(
  branchPattern: string,
  run: Runner = bunRun,
): Promise<CheckResult> {
  const wt = await run(["git", "worktree", "list", "--porcelain"], {});
  const worktrees = wt.stdout
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim());
  const strays = worktrees.filter((w) => w.includes("/.claude/worktrees/"));

  const br = await run(["git", "branch", "--list", branchPattern], {});
  const orphanBranches = parseNameOnly(br.stdout)
    .map((s) => s.replace(/^\*?\s*/, "").trim())
    .filter(Boolean);

  const problems: string[] = [];
  if (strays.length) problems.push(`stray worktree(s): ${strays.join(", ")}`);
  if (orphanBranches.length) problems.push(`orphan branch(es): ${orphanBranches.join(", ")}`);

  return {
    name: "cleanup",
    ok: problems.length === 0,
    detail: problems.length ? problems.join("; ") : undefined,
  };
}
