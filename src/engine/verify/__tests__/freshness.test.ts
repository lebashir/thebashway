// tools/orchestrator/verify/__tests__/freshness.test.ts
import { test, expect } from "bun:test";
import { checkFreshness } from "../freshness";
import type { Runner } from "../types";

const okRegen: Runner = async () => ({ code: 0, stdout: "", stderr: "" });

test("no regen command => fresh by definition", async () => {
  const r = await checkFreshness(
    { name: "x", dir: "tools", regen: null, derived: [] },
    okRegen,
  );
  expect(r.ok).toBe(true);
});

test("clean git diff after regen => fresh", async () => {
  const run: Runner = async (cmd) => {
    if (cmd[0] === "pnpm") return { code: 0, stdout: "", stderr: "" }; // regen
    return { code: 0, stdout: "", stderr: "" }; // git diff --name-only: empty
  };
  const r = await checkFreshness(
    {
      name: "organs",
      dir: "organs",
      regen: { name: "gen", cmd: ["pnpm", "gen:home"] },
      derived: ["organs/src/generated/home-snapshot.json"],
    },
    run,
  );
  expect(r.ok).toBe(true);
});

test("dirty derived artifact after regen => stale (fails, names the file)", async () => {
  const run: Runner = async (cmd) => {
    if (cmd[0] === "pnpm") return { code: 0, stdout: "", stderr: "" };
    // git diff --name-only reports the snapshot changed
    return {
      code: 1,
      stdout: "organs/src/generated/home-snapshot.json\n",
      stderr: "",
    };
  };
  const r = await checkFreshness(
    {
      name: "organs",
      dir: "organs",
      regen: { name: "gen", cmd: ["pnpm", "gen:home"] },
      derived: ["organs/src/generated/home-snapshot.json"],
    },
    run,
  );
  expect(r.ok).toBe(false);
  expect(r.detail).toContain("home-snapshot.json");
});
