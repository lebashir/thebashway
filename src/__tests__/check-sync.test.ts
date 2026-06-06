import { test, expect } from "bun:test";
import { parseDriftLog, checkSync } from "../check-sync";

test("parseDriftLog extracts non-empty commit lines", () => {
  expect(parseDriftLog("abc123 fix x\n\ndef456 feat y\n")).toEqual(["abc123 fix x", "def456 feat y"]);
});

test("checkSync reports commits since the ref (drift) via injected git", () => {
  const r = checkSync({ sinceRef: "abc", gitLog: () => "111 a\n222 b\n" });
  expect(r.inSync).toBe(false);
  expect(r.commits.length).toBe(2);
  expect(r.sinceRef).toBe("abc");
});

test("checkSync is in sync when no commits touched the engine since the ref", () => {
  const r = checkSync({ sinceRef: "abc", gitLog: () => "" });
  expect(r.inSync).toBe(true);
  expect(r.commits).toEqual([]);
});

test("checkSync cannot compute without a recorded ref", () => {
  const r = checkSync({ sinceRef: null });
  expect(r.inSync).toBe(false);
  expect(r.sinceRef).toBeNull();
});
