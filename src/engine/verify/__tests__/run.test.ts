// tools/orchestrator/verify/__tests__/run.test.ts
import { test, expect } from "bun:test";
import { parseNameOnly, bunRun, gitHead } from "../run";

test("parseNameOnly splits, trims, drops blanks", () => {
  expect(parseNameOnly("a/b.ts\norgans/x.tsx\n\n")).toEqual([
    "a/b.ts",
    "organs/x.tsx",
  ]);
  expect(parseNameOnly("")).toEqual([]);
});

test("bunRun captures stdout + exit code", async () => {
  const r = await bunRun(["bash", "-lc", "echo hi; exit 3"]);
  expect(r.stdout.trim()).toBe("hi");
  expect(r.code).toBe(3);
});

test("gitHead returns a 40-char sha for the repo", async () => {
  const head = await gitHead(process.cwd());
  expect(head).toMatch(/^[0-9a-f]{7,40}$/);
});
