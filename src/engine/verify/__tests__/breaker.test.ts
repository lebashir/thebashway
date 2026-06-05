import { test, expect } from "bun:test";
import { shouldTrip, overBudget } from "../../breaker";

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
