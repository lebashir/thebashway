// tools/orchestrator/verify/__tests__/smoke.test.ts
import { test, expect } from "bun:test";
import { runSmoke } from "../smoke";
import type { Runner } from "../types";

test("no smoke config => ok, skipped", async () => {
  const run: Runner = async () => ({ code: 0, stdout: "", stderr: "" });
  const r = await runSmoke(null, "organs", run, async () => 4111);
  expect(r.ok).toBe(true);
  expect(r.detail).toContain("skipped");
});

test("passes a free port via the configured env var", async () => {
  let seenEnv: Record<string, string> | undefined;
  const run: Runner = async (_cmd, opts) => {
    seenEnv = opts?.env;
    return { code: 0, stdout: "smoke passed: 8 routes\n", stderr: "" };
  };
  const r = await runSmoke(
    { cmd: ["pnpm", "exec", "tsx", "scripts/smoke-prod.ts"], portEnv: "SMOKE_PORT", needsBuild: true },
    "organs",
    run,
    async () => 4111,
  );
  expect(r.ok).toBe(true);
  expect(seenEnv?.SMOKE_PORT).toBe("4111");
});

test("non-zero smoke exit => fail", async () => {
  const run: Runner = async () => ({ code: 1, stdout: "", stderr: "SMOKE FAILED\n" });
  const r = await runSmoke(
    { cmd: ["pnpm", "exec", "tsx", "scripts/smoke-prod.ts"], portEnv: "SMOKE_PORT", needsBuild: true },
    "organs",
    run,
    async () => 4111,
  );
  expect(r.ok).toBe(false);
});

test("runs the smoke in the surface's declared cwd, not a hardcoded 'organs'", async () => {
  let seenCwd: string | undefined;
  const run: Runner = async (_cmd, opts) => {
    seenCwd = opts?.cwd;
    return { code: 0, stdout: "smoke passed\n", stderr: "" };
  };
  await runSmoke(
    { cmd: ["x"], portEnv: "SMOKE_PORT", needsBuild: false },
    "tools",
    run,
    async () => 4111,
  );
  expect(seenCwd).toBe("tools");
});
