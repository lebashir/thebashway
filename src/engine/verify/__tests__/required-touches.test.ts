import { test, expect } from "bun:test";
import { checkRequiredTouches, REQUIRED_TOUCHES } from "../../required-touches";

test("adding an organ (new sections/*/index.ts) requires registry.ts", () => {
  const changes = [{ status: "A" as const, path: "organs/src/sections/goals/index.ts" }];
  const results = checkRequiredTouches(changes, REQUIRED_TOUCHES);
  const r = results.find((c) => c.name === "required:organ-added-registry");
  expect(r?.ok).toBe(false);
  expect(r?.detail).toContain("registry.ts");
});

test("adding an organ WITH registry.ts change passes", () => {
  const changes = [
    { status: "A" as const, path: "organs/src/sections/goals/index.ts" },
    { status: "M" as const, path: "organs/src/registry.ts" },
  ];
  const results = checkRequiredTouches(changes, REQUIRED_TOUCHES);
  expect(results.find((c) => c.name === "required:organ-added-registry")?.ok).toBe(true);
});

test("editing an existing organ's component does NOT trigger the rule", () => {
  const changes = [{ status: "M" as const, path: "organs/src/sections/money/components/X.tsx" }];
  const results = checkRequiredTouches(changes, REQUIRED_TOUCHES);
  // rule not triggered => reported ok (vacuously satisfied)
  expect(results.find((c) => c.name === "required:organ-added-registry")?.ok).toBe(true);
});

test("deleting an organ's index.ts requires registry.ts", () => {
  const changes = [{ status: "D" as const, path: "organs/src/sections/sources/index.ts" }];
  const results = checkRequiredTouches(changes, REQUIRED_TOUCHES);
  expect(results.find((c) => c.name === "required:organ-removed-registry")?.ok).toBe(false);
});
