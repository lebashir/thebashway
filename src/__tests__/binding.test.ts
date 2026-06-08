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

// --- north-star: brief + briefDriftSensitivity defaults (resolved in the spread, NOT the :140 guard) ---

test("the minimal fixture still resolves — the :140 guard does NOT throw on a brief-less learning block", () => {
  // minimal.learning has NO `brief`; the throw guard must keep throwing only on missing local/decisions.
  expect(() => defineThebashway(minimal)).not.toThrow();
});

test("defineThebashway defaults brief + briefDriftSensitivity when omitted", () => {
  const b = defineThebashway(minimal);
  expect(b.learning.brief).toBe(".thebashway/brief.ts");
  expect(b.rails.briefDriftSensitivity).toBe("medium");
});

test("defineThebashway preserves an explicit brief + briefDriftSensitivity (default does not clobber)", () => {
  const b = defineThebashway({
    ...minimal,
    learning: { ...minimal.learning, brief: "custom/brief.ts" },
    rails: { ...minimal.rails, briefDriftSensitivity: "off" },
  });
  expect(b.learning.brief).toBe("custom/brief.ts");
  expect(b.rails.briefDriftSensitivity).toBe("off");
  // the rest of the learning/rails block survives the spread
  expect(b.learning.local).toBe(".thebashway/lessons.md");
  expect(b.rails.keywords).toBeInstanceOf(RegExp);
});

// --- north-star: requireBrief default true (resolved in the spread, NOT the :140 guard) ---

test("defineThebashway defaults requireBrief to true without the learning guard throwing", () => {
  const r = defineThebashway(minimal); // the existing minimal fixture
  expect(r.rails.requireBrief).toBe(true);
});

test("requireBrief:false is preserved", () => {
  const r = defineThebashway({ ...minimal, rails: { territoryGlobs: [], keywords: /x/, requireBrief: false } });
  expect(r.rails.requireBrief).toBe(false);
});
