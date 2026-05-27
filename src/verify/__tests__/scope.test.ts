// tools/orchestrator/verify/__tests__/scope.test.ts
import { test, expect } from "bun:test";
import { classifyChanges } from "../scope";

test("files inside a single-dir territory are all inside", () => {
  const r = classifyChanges(
    ["organs/src/sections/money/components/GoalsView.tsx"],
    ["organs/src/sections/money/**"],
  );
  expect(r.outside).toEqual([]);
  expect(r.inside).toHaveLength(1);
});

test("a file outside the territory is flagged", () => {
  const r = classifyChanges(
    [
      "organs/src/sections/money/components/GoalsView.tsx",
      "organs/src/sections/people/read.ts",
    ],
    ["organs/src/sections/money/**"],
  );
  expect(r.outside).toEqual(["organs/src/sections/people/read.ts"]);
});

test("multiple territory globs union (e.g. a section + an allowed companion)", () => {
  const r = classifyChanges(
    ["organs/src/sections/money/x.tsx", "organs/src/registry.ts"],
    ["organs/src/sections/money/**", "organs/src/registry.ts"],
  );
  expect(r.outside).toEqual([]);
});

test("`*` does not cross a slash; `**` does", () => {
  const r = classifyChanges(
    ["organs/src/sections/money/components/deep/X.tsx"],
    ["organs/src/sections/money/*"],
  );
  expect(r.outside).toHaveLength(1);
});
