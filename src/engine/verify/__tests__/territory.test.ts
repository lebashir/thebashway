import { test, expect } from "bun:test";
import { territoriesOverlap } from "../../territory";

test("a broad glob overlaps a file inside it", () => {
  expect(territoriesOverlap(["tools/orchestrator/**"], ["tools/orchestrator/queue.ts"])).toBe(true);
});

test("two distinct files in the same dir do NOT overlap", () => {
  expect(territoriesOverlap(["tools/orchestrator/queue.ts"], ["tools/orchestrator/config.ts"])).toBe(false);
});

test("disjoint trees do not overlap", () => {
  expect(territoriesOverlap(["organs/src/**"], ["tools/**"])).toBe(false);
});

test("a ** territory overlaps everything (conservative)", () => {
  expect(territoriesOverlap(["**"], ["organs/src/app/page.tsx"])).toBe(true);
});

test("sibling dirs with a shared name-prefix do NOT overlap (segment-aware)", () => {
  // 'tools/a' must not be treated as a prefix of 'tools/ab'
  expect(territoriesOverlap(["tools/a/**"], ["tools/ab/**"])).toBe(false);
});

test("identical territories overlap", () => {
  expect(territoriesOverlap(["tools/orchestrator/queue.ts"], ["tools/orchestrator/queue.ts"])).toBe(true);
});
