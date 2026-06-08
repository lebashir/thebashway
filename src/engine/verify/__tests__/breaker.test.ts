import { test, expect } from "bun:test";
import { shouldTrip, overBudget, goalMet } from "../../breaker";

test("does not trip when failures are below the threshold in the window", () => {
  expect(shouldTrip([true, false, true, false, true], 3, 5)).toBe(false); // 2 fails
});

test("alternating succeed/fail still trips (window, not consecutive)", () => {
  expect(shouldTrip([false, true, false, true, false], 3, 5)).toBe(true); // 3 fails in 5
});

test("only the last `window` outcomes count", () => {
  // 3 old fails, then a clean window of 5
  expect(shouldTrip([false, false, false, true, true, true, true, true], 3, 5)).toBe(false);
});

test("all-pass never trips", () => {
  expect(shouldTrip([true, true, true, true, true], 1, 5)).toBe(false);
});

test("overBudget compares used vs limit", () => {
  expect(overBudget(11, 10)).toBe(true);
  expect(overBudget(10, 10)).toBe(false);
});

// ---------------------------------------------------------------------------
// goalMet — the success-termination reducer (spec 3.2, 5.4, 8d)
// ---------------------------------------------------------------------------

const checked5 = { a: true, b: true, c: false, d: false, e: true };

test("goalMet: every id in the target passes => true", () => {
  expect(goalMet({ a: true, b: true }, new Set(["a", "b"]))).toBe(true);
});

test("goalMet: a target id that fails => false", () => {
  expect(goalMet({ a: true, b: false }, new Set(["a", "b"]))).toBe(false);
});

test("goalMet: a target id ABSENT from checked => false (unevaluated never counts as met)", () => {
  // 'b' is in the target but never appears in `checked` — treated as not-yet-passing.
  expect(goalMet({ a: true }, new Set(["a", "b"]))).toBe(false);
});

test("goalMet: EMPTY target => false (the vacuous-truth guard — nothing to drive toward is NOT done)", () => {
  expect(goalMet({ a: true, b: true }, new Set())).toBe(false);
  // even with an empty `checked`, an empty target must not vacuously report done.
  expect(goalMet({}, new Set())).toBe(false);
});

test("goalMet: strict-subset slice — a 2-of-5 target of passing ids is true though the other 3 fail", () => {
  // a,b,e pass; c,d fail. Aiming only at {a,b} terminates even though c,d are red.
  expect(goalMet(checked5, new Set(["a", "b"]))).toBe(true);
});

test("goalMet: strict-subset slice — the same 2-of-5 target is false if one of the two fails", () => {
  // {a,c}: a passes but c fails => the slice is not met.
  expect(goalMet(checked5, new Set(["a", "c"]))).toBe(false);
});

test("goalMet: accepts a Map as the checked store", () => {
  const m = new Map<string, boolean>([
    ["a", true],
    ["b", true],
    ["c", false],
  ]);
  expect(goalMet(m, new Set(["a", "b"]))).toBe(true);
  expect(goalMet(m, new Set(["a", "c"]))).toBe(false);
  expect(goalMet(m, new Set(["a", "missing"]))).toBe(false);
  expect(goalMet(m, new Set())).toBe(false);
});
