import { test, expect } from "bun:test";
import { parseNameStatus } from "../run";

test("parses A/M/D lines into {status, path}", () => {
  const out = "A\torgans/src/sections/x/index.ts\nM\torgans/src/registry.ts\nD\told/file.ts\n";
  expect(parseNameStatus(out)).toEqual([
    { status: "A", path: "organs/src/sections/x/index.ts" },
    { status: "M", path: "organs/src/registry.ts" },
    { status: "D", path: "old/file.ts" },
  ]);
});

test("rename lines (R100\\told\\tnew) record the NEW path as modified", () => {
  const out = "R100\tsrc/a.ts\tsrc/b.ts\n";
  expect(parseNameStatus(out)).toEqual([{ status: "M", path: "src/b.ts" }]);
});

test("blank input => empty", () => {
  expect(parseNameStatus("")).toEqual([]);
});
