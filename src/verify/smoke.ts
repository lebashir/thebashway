// src/verify/smoke.ts
import type { CheckResult, Runner } from "./types";
import { bunRun } from "./run";
import { freePort } from "./ports";

type SmokeCfg = { cmd: string[]; portEnv: string; needsBuild: boolean } | null;

/**
 * Run the surface's prod-render smoke on a fresh ephemeral port so parallel runs
 * never collide. `cwd` is the surface directory (from config) — the smoke command
 * runs there. The smoke script itself should anchor on HTTP status + an expected
 * positive marker per route (never grep prose for scary words).
 */
export async function runSmoke(
  cfg: SmokeCfg,
  cwd: string,
  run: Runner = bunRun,
  getPort: () => Promise<number> = freePort,
): Promise<CheckResult> {
  if (!cfg) return { name: "smoke", ok: true, detail: "skipped (no smoke surface)" };
  const port = await getPort();
  const r = await run(cfg.cmd, { cwd, env: { [cfg.portEnv]: String(port) } });
  return {
    name: "smoke",
    ok: r.code === 0,
    detail: r.code === 0 ? `port ${port}` : `exit ${r.code}: ${r.stderr.trim().slice(0, 200)}`,
  };
}
