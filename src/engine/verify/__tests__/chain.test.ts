// tools/orchestrator/verify/__tests__/chain.test.ts
import { test, expect } from "bun:test";
import { runChain } from "../chain";
import type { Runner } from "../types";

test("all commands pass => ok, output concatenated, each recorded", async () => {
  const run: Runner = async (cmd) => ({ code: 0, stdout: `${cmd[0]} ok\n`, stderr: "" });
  const r = await runChain(
    [{ name: "tsc", cmd: ["tsc"] }, { name: "test", cmd: ["vitest"] }],
    { dir: "organs" },
    run,
  );
  expect(r.ok).toBe(true);
  expect(r.results.map((c) => c.name)).toEqual(["tsc", "test"]);
  expect(r.output).toContain("=== tsc ===");
  expect(r.output).toContain("=== test ===");
});

test("a failing command marks that check failed but the rest still run", async () => {
  const run: Runner = async (cmd) =>
    cmd[0] === "lint"
      ? { code: 1, stdout: "", stderr: "lint boom\n" }
      : { code: 0, stdout: "ok\n", stderr: "" };
  const r = await runChain(
    [{ name: "lint", cmd: ["lint"] }, { name: "build", cmd: ["build"] }],
    { dir: "organs" },
    run,
  );
  expect(r.ok).toBe(false);
  expect(r.results.find((c) => c.name === "lint")?.ok).toBe(false);
  expect(r.results.find((c) => c.name === "build")?.ok).toBe(true);
});

test("surface env is passed to every command", async () => {
  const seen: Array<Record<string, string> | undefined> = [];
  const run: Runner = async (_cmd, opts) => {
    seen.push(opts?.env);
    return { code: 0, stdout: "", stderr: "" };
  };
  await runChain(
    [{ name: "test", cmd: ["bun", "test"] }],
    { dir: "tools", env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } },
    run,
  );
  expect(seen[0]?.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0");
});
