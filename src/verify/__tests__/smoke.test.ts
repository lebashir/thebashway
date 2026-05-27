import { test, expect } from "bun:test";
import { runSmoke } from "../smoke";
import type { Runner } from "../types";

test("no smoke config => ok, skipped", async () => {
  const run: Runner = async () => ({ code: 0, stdout: "", stderr: "" });
  const r = await runSmoke(null, "app", run, async () => 4111);
  expect(r.ok).toBe(true);
  expect(r.detail).toContain("skipped");
});

test("runs the smoke command in the given cwd with a free port in the env var", async () => {
  let seenEnv: Record<string, string> | undefined;
  let seenCwd: string | undefined;
  const run: Runner = async (_cmd, opts) => {
    seenEnv = opts?.env;
    seenCwd = opts?.cwd;
    return { code: 0, stdout: "smoke passed\n", stderr: "" };
  };
  const r = await runSmoke(
    { cmd: ["pnpm", "exec", "tsx", "scripts/smoke.ts"], portEnv: "SMOKE_PORT", needsBuild: true },
    "app",
    run,
    async () => 4111,
  );
  expect(r.ok).toBe(true);
  expect(seenEnv?.SMOKE_PORT).toBe("4111");
  expect(seenCwd).toBe("app");
});

test("non-zero smoke exit => fail", async () => {
  const run: Runner = async () => ({ code: 1, stdout: "", stderr: "SMOKE FAILED\n" });
  const r = await runSmoke(
    { cmd: ["pnpm", "exec", "tsx", "scripts/smoke.ts"], portEnv: "SMOKE_PORT", needsBuild: true },
    "app",
    run,
    async () => 4111,
  );
  expect(r.ok).toBe(false);
});
