import { test, expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatRecord,
  summaryLine,
  appendDigest,
  formatReflection,
  appendReflection,
  type DigestRecord,
  type ReflectionRecord,
} from "../../digest";

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

// --- DigestRecord schema is FROZEN at 6 fields (spec 5.5). Guard it stays 6, field-by-field. ---

test("DigestRecord stays the FROZEN 6-field schema", () => {
  const keys = Object.keys(rec).sort();
  expect(keys).toEqual(
    ["anomalies", "deployResult", "item", "manifestHash", "questionsAsked", "reviewVerdict"].sort(),
  );
  expect(keys).toHaveLength(6);
});

// ---------------------------------------------------------------------------
// ReflectionRecord (Loop C) — a SEPARATE interface beside the frozen DigestRecord.
// ---------------------------------------------------------------------------

const mkReflect = (over: Partial<ReflectionRecord> = {}): ReflectionRecord => ({
  milestone: "epic: north-star",
  learned: ["the brief seam stayed pure"],
  briefStillValid: true,
  onPath: true,
  ...over,
});

test("formatReflection renders the core fields in order", () => {
  const s = formatReflection(mkReflect());
  const order = ["milestone:", "learned:", "briefStillValid:", "onPath:"];
  let last = -1;
  for (const f of order) {
    const idx = s.indexOf(f);
    expect(idx).toBeGreaterThan(last);
    last = idx;
  }
  expect(s).toContain("milestone: epic: north-star");
  expect(s).toContain("briefStillValid: true");
  expect(s).toContain("onPath: true");
});

test("formatReflection renders optional fields ONLY when present", () => {
  const bare = formatReflection(mkReflect());
  expect(bare).not.toContain("driftedCriteria:");
  expect(bare).not.toContain("proposedUpdate:");
  expect(bare).not.toContain("proposedConventions:");
  expect(bare).not.toContain("proposedGlossary:");

  const full = formatReflection(
    mkReflect({
      onPath: false,
      driftedCriteria: ["c1", "c2"],
      proposedUpdate: "tighten the scope line",
      proposedConventions: ["land via the green gate only"],
      proposedGlossary: [{ term: "basha", means: "a headless build agent" }],
    }),
  );
  expect(full).toContain("driftedCriteria: c1, c2");
  expect(full).toContain("proposedUpdate: tighten the scope line");
  expect(full).toContain("proposedConventions: land via the green gate only");
  expect(full).toContain("proposedGlossary: basha=a headless build agent");
});

test("appendReflection creates the log if absent and appends, like appendDigest", async () => {
  const p = join(tmpdir(), `reflect-${Math.random().toString(36).slice(2)}.md`);
  expect(existsSync(p)).toBe(false);
  await appendReflection(p, mkReflect({ milestone: "first" }));
  await appendReflection(p, mkReflect({ milestone: "second", proposedUpdate: "add a convention" }));
  const text = await Bun.file(p).text();
  expect(text).toContain("milestone: first");
  expect(text).toContain("milestone: second");
  expect(text).toContain("proposedUpdate: add a convention");
  expect(existsSync(p)).toBe(true);
  unlinkSync(p);
});

// ---------------------------------------------------------------------------
// THE NO-AUTO-WRITE RAIL TEST (the single most important test, spec 5.5/8c, INV-A).
// A ReflectionRecord carrying a proposedUpdate (and the conventions/glossary growth a
// future contributor is most tempted to auto-append) causes ZERO writes to the BRIEF
// PATH — asserted across BOTH the reflection path AND a drain/digest path. We spy
// Bun.write AND fs.writeFileSync and prove no call targets the brief path.
// ---------------------------------------------------------------------------

/** Install spies on Bun.write + fs.writeFileSync that RECORD targets and DELEGATE to the real impl
 *  (so the log really lands). Returns the captured target paths + a restore fn. */
function spyWrites(): { targets: string[]; restore: () => void } {
  const targets: string[] = [];
  const origBunWrite = Bun.write.bind(Bun);
  const origFsWrite = fs.writeFileSync;
  const origFsAppend = fs.appendFileSync;
  const bunSpy = spyOn(Bun, "write").mockImplementation((dest: unknown, ...rest: unknown[]) => {
    targets.push(typeof dest === "string" ? dest : String((dest as { name?: string })?.name ?? dest));
    // @ts-expect-error — delegate to the real impl
    return origBunWrite(dest, ...rest);
  });
  const fsSpy = spyOn(fs, "writeFileSync").mockImplementation((path: unknown, ...rest: unknown[]) => {
    targets.push(String(path));
    // @ts-expect-error — delegate to the real impl
    return origFsWrite(path, ...rest);
  });
  // Also spy appendFileSync — the append primitive a future contributor is most tempted to use to
  // auto-grow conventions/glossary onto brief.ts. Without this the rail is not airtight against it.
  const fsAppendSpy = spyOn(fs, "appendFileSync").mockImplementation((path: unknown, ...rest: unknown[]) => {
    targets.push(String(path));
    // @ts-expect-error — delegate to the real impl
    return origFsAppend(path, ...rest);
  });
  return {
    targets,
    restore: () => {
      bunSpy.mockRestore();
      fsSpy.mockRestore();
      fsAppendSpy.mockRestore();
    },
  };
}

test("RAIL: a proposedUpdate reflection writes the LOG only — ZERO writes to the brief path", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "reflect-rail-"));
  const logPath = join(dir, "run-log.md");
  const briefPath = join(dir, "brief.ts");

  const spy = spyWrites();
  try {
    await appendReflection(
      logPath,
      mkReflect({ milestone: "epic done", proposedUpdate: "narrow inScopeSurfaces to tools" }),
    );
  } finally {
    spy.restore();
  }

  // The log was written; the brief was NOT.
  expect(spy.targets.some((t) => t.includes("run-log.md"))).toBe(true);
  expect(spy.targets.some((t) => t === briefPath || t.endsWith("brief.ts"))).toBe(false);
  expect(existsSync(briefPath)).toBe(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("RAIL: a proposedConventions/proposedGlossary growth reflection does ZERO brief-path writes", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "reflect-grow-"));
  const logPath = join(dir, "run-log.md");
  const briefPath = join(dir, "brief.ts");

  const spy = spyWrites();
  try {
    await appendReflection(
      logPath,
      mkReflect({
        milestone: "epic done",
        proposedConventions: ["always land via the green gate", "ISO dates everywhere"],
        proposedGlossary: [
          { term: "park", means: "stage a question for the human, keep going" },
          { term: "drain", means: "build the claimable queue items" },
        ],
      }),
    );
  } finally {
    spy.restore();
  }

  expect(spy.targets.some((t) => t.includes("run-log.md"))).toBe(true);
  expect(spy.targets.some((t) => t.endsWith("brief.ts"))).toBe(false);
  expect(existsSync(briefPath)).toBe(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("RAIL: the drain/digest path (appendDigest) also does ZERO brief-path writes", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "digest-rail-"));
  const logPath = join(dir, "run-log.md");
  const briefPath = join(dir, "brief.ts");

  const spy = spyWrites();
  try {
    await appendDigest(logPath, mkRec({ item: "landed feature" }));
    // A reflection carrying growth, on the SAME drain/digest log path.
    await appendReflection(
      logPath,
      mkReflect({ milestone: "epic done", proposedUpdate: "add glossary", proposedGlossary: [{ term: "x", means: "y" }] }),
    );
  } finally {
    spy.restore();
  }

  expect(spy.targets.some((t) => t.includes("run-log.md"))).toBe(true);
  expect(spy.targets.some((t) => t.endsWith("brief.ts"))).toBe(false);
  expect(existsSync(briefPath)).toBe(false);
  fs.rmSync(dir, { recursive: true, force: true });
});
