import { test, expect } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatRecord, summaryLine, appendDigest, type DigestRecord } from "../../digest";

const rec: DigestRecord = {
  item: "Reskin Goals",
  manifestHash: "abc123",
  reviewVerdict: "pass",
  deployResult: "deployed",
  anomalies: [],
  questionsAsked: 0,
};

const mkRec = (over: Partial<DigestRecord> = {}): DigestRecord => ({
  item: "Wire gate",
  manifestHash: "abc123",
  reviewVerdict: "clean",
  deployResult: "deployed",
  anomalies: [],
  questionsAsked: 0,
  ...over,
});

test("formatRecord includes all five fields in order", () => {
  const s = formatRecord(rec);
  const order = ["item:", "manifest:", "review:", "deploy:", "anomalies:"];
  let last = -1;
  for (const f of order) {
    const idx = s.indexOf(f);
    expect(idx).toBeGreaterThan(last);
    last = idx;
  }
  expect(s).toContain("anomalies: none");
});

test("summaryLine is one line and surfaces anomalies", () => {
  const blocked: DigestRecord = { ...rec, deployResult: "blocked", anomalies: ["smoke red", "1 retry"] };
  const line = summaryLine(blocked);
  expect(line.split("\n")).toHaveLength(1);
  expect(line).toContain("blocked");
  expect(line).toContain("smoke red");
});

test("appendDigest appends to the log", async () => {
  const p = join(tmpdir(), `digest-${Math.random().toString(36).slice(2)}.md`);
  await appendDigest(p, rec);
  await appendDigest(p, { ...rec, item: "Second" });
  const text = await Bun.file(p).text();
  expect(text).toContain("item: Reskin Goals");
  expect(text).toContain("item: Second");
  expect(existsSync(p)).toBe(true);
  unlinkSync(p);
});

test("formatRecord includes the question count", () => {
  expect(formatRecord(mkRec({ questionsAsked: 2 }))).toContain("questions: 2");
});

test("summaryLine flags a non-zero question count", () => {
  expect(summaryLine(mkRec({ questionsAsked: 1 }))).toContain("1 question");
  expect(summaryLine(mkRec({ questionsAsked: 0 }))).not.toContain("question");
});
