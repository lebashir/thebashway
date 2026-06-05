import { test, expect } from "bun:test";
import { defineThebashway } from "../binding";

const minimal = {
  repoRoot: "/tmp/x",
  surfaces: { app: { dir: ".", role: "default home", chain: [{ name: "test", cmd: ["bun", "test"] }] } },
  defaultSurface: "app",
  rails: { territoryGlobs: [], keywords: /a^/ },
  learning: { local: ".thebashway/lessons.md", decisions: ".thebashway/decisions.md" },
};

test("defineThebashway validates and resolves defaults", () => {
  const b = defineThebashway(minimal);
  expect(b.defaultSurface).toBe("app");
  expect(b.surfaces.app.chain[0].name).toBe("test");
  // defaults filled in:
  expect(b.branchPattern).toBe("tbw/*");
  expect(b.breaker).toEqual({ maxFailures: 2, window: 3 });
  expect(b.maxConcurrent).toBe(6);
  expect(b.seedPaths).toEqual([]);
});

test("throws when defaultSurface is not a surface key", () => {
  expect(() => defineThebashway({ ...minimal, defaultSurface: "nope" })).toThrow(/defaultSurface/);
});

test("throws when an auditTarget names an unknown surface", () => {
  expect(() =>
    defineThebashway({
      ...minimal,
      auditTargets: { money: { surface: "ghost", rootGlob: "**", subAreas: [] } },
    }),
  ).toThrow(/auditTarget/);
});

test("throws when there are no surfaces", () => {
  expect(() => defineThebashway({ ...minimal, surfaces: {} })).toThrow(/at least one surface/);
});

test("throws when learning paths are missing", () => {
  expect(() => defineThebashway({ ...minimal, learning: { local: "", decisions: "" } })).toThrow(/learning/);
});
