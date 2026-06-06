import { test, expect } from "bun:test";
import { buildIntakePrompt } from "../../intake-prompt";
import type { Lesson } from "../../lessons";

const store: Lesson[] = [
  { tag: "decision", rule: "prefer the lean option" },        // global
  { tag: "tools", rule: "tools surface has no prod deploy" }, // area-scoped
  { tag: "organs", rule: "organs UI is FROZEN" },             // other area
];

test("global [decision] rules always inject; matching area injects; other areas do not", () => {
  const out = buildIntakePrompt({ decisionLessons: store, itemAreas: ["tools"], taskBody: "INTAKE: foo" });
  expect(out).toContain("prefer the lean option"); // global, always
  expect(out).toContain("tools surface has no prod deploy"); // area match
  expect(out).not.toContain("organs UI is FROZEN"); // non-matching area dropped
  expect(out).toContain("INTAKE: foo");
});

test("with no area, only global decision rules inject", () => {
  const out = buildIntakePrompt({ decisionLessons: store, itemAreas: [], taskBody: "x" });
  expect(out).toContain("prefer the lean option");
  expect(out).not.toContain("tools surface has no prod deploy");
});
