// tools/orchestrator/verify/freshness.ts
import type { CheckResult, Check, Runner } from "./types";
import { bunRun, parseNameOnly } from "./run";

/**
 * Regenerate derived artifacts and assert they didn't change vs the committed
 * tree. A change means the committed snapshot was stale — the failure-#3 guard.
 * `dir` is the cwd for the regen command; `derived` are repo-root-relative paths.
 */
export async function checkFreshness(
  surface: { name: string; dir: string; regen: Check | null; derived: string[] },
  run: Runner = bunRun,
): Promise<CheckResult> {
  if (!surface.regen || surface.derived.length === 0) {
    return { name: "freshness", ok: true, detail: "no derived artifacts" };
  }
  const regen = await run(surface.regen.cmd, { cwd: surface.dir });
  if (regen.code !== 0) {
    return { name: "freshness", ok: false, detail: `regen failed: ${regen.stderr.trim()}` };
  }
  // git diff --name-only restricted to the derived paths; run from repo root.
  const diff = await run(["git", "diff", "--name-only", "--", ...surface.derived], {});
  const changed = parseNameOnly(diff.stdout);
  if (changed.length > 0) {
    return {
      name: "freshness",
      ok: false,
      detail: `stale derived artifact(s) — regenerate and commit: ${changed.join(", ")}`,
    };
  }
  return { name: "freshness", ok: true };
}
