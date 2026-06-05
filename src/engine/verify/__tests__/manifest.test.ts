// tools/orchestrator/verify/__tests__/manifest.test.ts
import { test, expect } from "bun:test";
import { sha256, buildManifest, verifyManifest } from "../manifest";

const base = {
  surface: "organs",
  baseRef: "abc123",
  head: "def456",
  territory: ["organs/src/sections/money/**"],
  diffText: "diff --git a b\n+changed",
  outputText: "tsc ok\nlint ok\n",
  checks: [{ name: "tsc", ok: true }],
};

test("sha256 is stable and hex", () => {
  expect(sha256("hello")).toBe(sha256("hello"));
  expect(sha256("hello")).toMatch(/^[0-9a-f]{64}$/);
});

test("buildManifest hashes diff and output", () => {
  const m = buildManifest(base);
  expect(m.diffSha256).toBe(sha256(base.diffText));
  expect(m.outputSha256).toBe(sha256(base.outputText));
  expect(m.ok).toBe(true);
});

test("verifyManifest passes when diff+output match", () => {
  const m = buildManifest(base);
  expect(verifyManifest(m, base.diffText, base.outputText)).toBe(true);
});

test("verifyManifest fails on a tampered diff", () => {
  const m = buildManifest(base);
  expect(verifyManifest(m, base.diffText + "X", base.outputText)).toBe(false);
});
