import { test, expect } from "bun:test";
import { checkRequiredTouches, type TouchRule } from "../../required-touches";

const RULES: TouchRule[] = [
  {
    name: "section-added-requires-registry",
    whenStatus: ["A"],
    whenGlob: "src/sections/*/index.ts",
    requireGlob: "src/registry.ts",
    message: "added a section but src/registry.ts is unchanged",
  },
];

test("fires and fails when the trigger matches but the required file is missing", () => {
  const r = checkRequiredTouches([{ status: "A", path: "src/sections/x/index.ts" }], RULES);
  expect(r[0].ok).toBe(false);
  expect(r[0].detail).toContain("registry.ts");
});

test("satisfied when the required file is also changed", () => {
  const r = checkRequiredTouches(
    [
      { status: "A", path: "src/sections/x/index.ts" },
      { status: "M", path: "src/registry.ts" },
    ],
    RULES,
  );
  expect(r[0].ok).toBe(true);
});

test("vacuously ok when the rule is not triggered", () => {
  const r = checkRequiredTouches([{ status: "M", path: "src/other.ts" }], RULES);
  expect(r[0].ok).toBe(true);
});

test("empty rules => no checks", () => {
  expect(checkRequiredTouches([{ status: "A", path: "anything" }], [])).toEqual([]);
});
