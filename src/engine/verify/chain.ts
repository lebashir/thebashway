// tools/orchestrator/verify/chain.ts
import type { Check, CheckResult, Runner } from "./types";
import { bunRun } from "./run";

/** Run a surface's gate-chain commands in order; record every result. */
export async function runChain(
  checks: Check[],
  surface: { dir: string; env?: Record<string, string> },
  run: Runner = bunRun,
): Promise<{ ok: boolean; results: CheckResult[]; output: string }> {
  const results: CheckResult[] = [];
  let output = "";
  for (const check of checks) {
    const r = await run(check.cmd, { cwd: surface.dir, env: surface.env });
    output += `\n=== ${check.name} ===\n${r.stdout}${r.stderr}`;
    results.push({
      name: check.name,
      ok: r.code === 0,
      detail: r.code === 0 ? undefined : `exit ${r.code}`,
    });
  }
  return { ok: results.every((c) => c.ok), results, output };
}
