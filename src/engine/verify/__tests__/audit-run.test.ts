import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import {
  runAudit,
  extractJsonBlock,
  parseFindings,
  parseVerdicts,
  parseShaped,
  type AuditDeps,
} from "../../audit-run";
import { parseQueue, type QueueItem } from "../../queue";
import type { Finding, CompletableItem, AuditPlan } from "../../audit";
import { AUDIT_CONFIRM_MIN_CONFIDENCE, AUDIT_BUILDREADY_MIN_CONFIDENCE } from "../../config";

// A target the registry resolves WITHOUT touching the filesystem: "money" exists in
// AUDIT_TARGETS with a fixed sub-area list.
const TARGET = "money";

const QHEADER = "# build queue\n\nThe shared work queue.\n";
async function emptyQueue(): Promise<string> {
  const p = join(tmpdir(), `audit-q-${Math.random().toString(36).slice(2)}.md`);
  await Bun.write(p, `${QHEADER}\n`);
  return p;
}
async function readItems(p: string): Promise<QueueItem[]> {
  return parseQueue(await Bun.file(p).text());
}
function cleanup(p: string) {
  try {
    if (existsSync(p)) unlinkSync(p);
    if (existsSync(`${p}.lock`)) unlinkSync(`${p}.lock`);
  } catch {
    /* ignore */
  }
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    title: "Bug X",
    description: "something is wrong",
    subArea: "organs/src/sections/money/read.ts",
    confidence: 0.9,
    freezeSafe: true,
    ...over,
  };
}

function completable(over: Partial<CompletableItem> = {}): CompletableItem {
  return {
    title: "Fix Bug X",
    goal: "fix it",
    territory: ["organs/src/sections/money/read.ts"],
    doneWhen: "verify green",
    status: "unclaimed",
    freezeSafe: true,
    ...over,
  };
}

// fanoutMax:1 → exactly one finder call per run, so finding counts are deterministic
// regardless of how many sub-areas the target has (money has 5). Tests that need
// multiple finder calls override fanoutMax.
const opts = (queuePath: string, over = {}) => ({
  target: TARGET,
  queuePath,
  repoRoot: "/repo",
  decisionsPath: "/repo/decisions.md",
  fanoutMax: 1,
  ...over,
});

function mkDeps(over: Partial<AuditDeps>): AuditDeps {
  return {
    runFinder: async () => [finding()],
    runVerify: async (fs) => fs.map((f) => ({ finding: f, isReal: true, confidence: f.confidence })),
    runShape: async (f) => completable({ title: `Fix ${f.title}` }),
    ...over,
  };
}

// ---------------------------------------------------------------------------

test("happy path: find → verify → shape → enqueue, reports counts", async () => {
  const p = await emptyQueue();
  const report = await runAudit(opts(p), mkDeps({}));
  expect(report.plan.surface).toBe("organs"); // money lives in organs
  expect(report.findingCount).toBeGreaterThan(0);
  expect(report.confirmedCount).toBeGreaterThan(0);
  expect(report.shaped.length).toBeGreaterThan(0);
  expect(report.enqueued?.appended).toBe(report.shaped.length);
  expect(report.enqueued?.buildReady).toBeGreaterThan(0);
  const items = await readItems(p);
  expect(items.length).toBe(report.shaped.length);
  // Enqueued items are origin:auto + carry an audit fingerprint.
  expect(items.every((i) => i.origin === "auto")).toBe(true);
  expect(items.every((i) => (i.source ?? "").startsWith("audit:"))).toBe(true);
  cleanup(p);
});

test("refute filter drops !isReal and below-confirm-confidence findings", async () => {
  const p = await emptyQueue();
  const report = await runAudit(
    opts(p),
    mkDeps({
      // One finder yields three findings; verify refutes one, low-confidences another.
      runFinder: async () => [
        finding({ title: "Real", confidence: 0.95 }),
        finding({ title: "Fake" }),
        finding({ title: "Weak" }),
      ],
      runVerify: async (fs) =>
        fs.map((f) => {
          if (f.title === "Fake") return { finding: f, isReal: false, confidence: 0.9 };
          if (f.title === "Weak") return { finding: f, isReal: true, confidence: 0.5 }; // below 0.7
          return { finding: f, isReal: true, confidence: 0.95 };
        }),
    }),
  );
  expect(report.findingCount).toBe(3);
  expect(report.confirmedCount).toBe(1); // only "Real"
  expect(report.shaped.length).toBe(1);
  cleanup(p);
});

test("a finder that throws drops to [] and never aborts the whole audit", async () => {
  const p = await emptyQueue();
  let call = 0;
  const report = await runAudit(
    opts(p, { fanoutMax: 2 }), // two finder calls: first throws, second survives
    mkDeps({
      runFinder: async (subArea) => {
        call++;
        if (call === 1) throw new Error("finder crashed");
        return [finding({ title: `from-${subArea}` })];
      },
    }),
  );
  // The surviving finders still produced findings.
  expect(report.findingCount).toBeGreaterThan(0);
  cleanup(p);
});

test("a malformed finding object is filtered out by the schema", async () => {
  const p = await emptyQueue();
  const report = await runAudit(
    opts(p),
    mkDeps({
      runFinder: async () =>
        [
          finding({ title: "Good" }),
          { title: "Bad", description: "missing fields" } as unknown as Finding, // invalid
        ],
    }),
  );
  expect(report.findingCount).toBe(1); // only the valid one survives
  cleanup(p);
});

test("confidence floor: a confirmed-but-below-buildready finding is downgraded to needs-intake", async () => {
  const p = await emptyQueue();
  const report = await runAudit(
    opts(p),
    mkDeps({
      runFinder: async () => [finding({ title: "Borderline", confidence: 0.75 })], // >=0.7 confirm, <0.8 buildready
      runVerify: async (fs) => fs.map((f) => ({ finding: f, isReal: true, confidence: 0.75 })),
      runShape: async () => completable({ title: "Fix Borderline", status: "unclaimed" }),
    }),
  );
  expect(report.confirmedCount).toBe(1);
  expect(report.downgradedLowConfidence).toBe(1);
  const items = await readItems(p);
  expect(items[0].status).toBe("needs-intake"); // forced down, not build-ready
  cleanup(p);
});

test("freeze-unsafe / open-question findings enqueue as needs-intake (effectiveQueueStatus)", async () => {
  const p = await emptyQueue();
  await runAudit(
    opts(p),
    mkDeps({
      runFinder: async () => [finding({ title: "UI", freezeSafe: false, confidence: 0.95 })],
      runVerify: async (fs) => fs.map((f) => ({ finding: f, isReal: true, confidence: 0.95 })),
      runShape: async () => completable({ title: "Fix UI", freezeSafe: false, status: "unclaimed" }),
    }),
  );
  const items = await readItems(p);
  expect(items[0].status).toBe("needs-intake"); // freezeSafe:false forced down by enqueueFindings
  cleanup(p);
});

test("dry-run writes nothing to the queue and reports enqueued=null", async () => {
  const p = await emptyQueue();
  const before = await Bun.file(p).text();
  const report = await runAudit(opts(p, { dryRun: true }), mkDeps({}));
  expect(report.shaped.length).toBeGreaterThan(0); // it still computed the findings
  expect(report.enqueued).toBeNull();
  expect(await Bun.file(p).text()).toBe(before); // untouched
  cleanup(p);
});

test("unknown target throws (surfaced by the CLI)", async () => {
  const p = await emptyQueue();
  await expect(runAudit(opts(p, { target: "totally-unknown-xyz" }), mkDeps({}))).rejects.toThrow();
  cleanup(p);
});

test("per-audit cap keeps the highest-confidence findings and drops the rest", async () => {
  const p = await emptyQueue();
  const many = Array.from({ length: 5 }, (_, i) =>
    finding({ title: `F${i}`, confidence: 0.7 + i * 0.05 }),
  );
  const report = await runAudit(
    opts(p, { maxEnqueue: 2 }),
    mkDeps({
      runFinder: async () => many,
      runVerify: async (fs) => fs.map((f) => ({ finding: f, isReal: true, confidence: f.confidence })),
      runShape: async (f) => completable({ title: `Fix ${f.title}` }),
    }),
  );
  expect(report.confirmedCount).toBe(5);
  expect(report.shaped.length).toBe(2);
  expect(report.droppedOverCap).toBe(3);
  // Kept the two highest-confidence (F4=0.90, F3=0.85).
  expect(new Set(report.shaped.map((s) => s.title))).toEqual(new Set(["Fix F4", "Fix F3"]));
  cleanup(p);
});

test("report reconciles by fingerprint: two same-title+territory items don't over-count", async () => {
  const p = await emptyQueue();
  const report = await runAudit(
    opts(p, { fanoutMax: 1 }),
    mkDeps({
      runFinder: async () => [finding({ title: "Dup1" }), finding({ title: "Dup2" })],
      runVerify: async (fs) => fs.map((f) => ({ finding: f, isReal: true, confidence: 0.95 })),
      // Both shape to an identical title+territory → one audit fingerprint → one append.
      runShape: async () => completable({ title: "Same Fix", territory: ["organs/src/sections/money/read.ts"] }),
    }),
  );
  expect(report.enqueued?.appended).toBe(1); // deduped to one
  // The report stays internally consistent (no title-based double count).
  expect((report.enqueued!.buildReady + report.enqueued!.needInput)).toBe(report.enqueued!.appended);
  cleanup(p);
});

test("re-audit of the same area dedupes (skippedExisting on the second run)", async () => {
  const p = await emptyQueue();
  await runAudit(opts(p), mkDeps({}));
  const second = await runAudit(opts(p), mkDeps({}));
  expect(second.enqueued?.appended).toBe(0);
  expect(second.enqueued?.skippedExisting).toBeGreaterThan(0);
  cleanup(p);
});

test("confidence thresholds are the documented bars", () => {
  expect(AUDIT_CONFIRM_MIN_CONFIDENCE).toBe(0.7);
  expect(AUDIT_BUILDREADY_MIN_CONFIDENCE).toBe(0.8);
  expect(AUDIT_BUILDREADY_MIN_CONFIDENCE).toBeGreaterThan(AUDIT_CONFIRM_MIN_CONFIDENCE);
});

// ---------------------------------------------------------------------------
// Pure JSON-parsing helpers (the fragile part of the real default deps)
// ---------------------------------------------------------------------------

test("extractJsonBlock: prefers the LAST fenced ```json block", () => {
  const out = "prose\n```json\n[1]\n```\nmore\n```json\n[2,3]\n```\ntail";
  expect(extractJsonBlock(out)).toBe("[2,3]");
});

test("extractJsonBlock: falls back to a bare array when unfenced", () => {
  const out = 'here is the result: [{"a":1}] done';
  expect(extractJsonBlock(out)).toBe('[{"a":1}]');
});

test("extractJsonBlock: null when there is no JSON at all", () => {
  expect(extractJsonBlock("no json here, just words")).toBeNull();
});

test("extractJsonBlock: stray brackets in prose don't shadow the real array", () => {
  // The reviewer's empirical case: a short stray [42] must not win over the real array.
  const out = 'see line [42]: [{"title":"A","description":"d","subArea":"s","confidence":0.9,"freezeSafe":true}] done';
  const block = extractJsonBlock(out)!;
  const parsed = JSON.parse(block);
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed[0].title).toBe("A"); // not [42]
});

test("extractJsonBlock: an unfenced object with a nested array returns the OBJECT", () => {
  const out = 'result: {"title":"T","territory":["a/**"],"status":"unclaimed"}';
  const parsed = JSON.parse(extractJsonBlock(out)!);
  expect(Array.isArray(parsed)).toBe(false);
  expect(parsed.title).toBe("T"); // not the nested territory array
});

test("parseFindings: validates, defaults the subArea, drops malformed entries", () => {
  const out =
    "```json\n" +
    JSON.stringify([
      { title: "A", description: "d", confidence: 0.9, freezeSafe: true }, // subArea omitted → defaulted
      { title: "B", description: "d", subArea: "x", confidence: 2, freezeSafe: true }, // confidence>1 invalid
      { nope: true }, // junk
    ]) +
    "\n```";
  const findings = parseFindings(out, "default/sub/**");
  expect(findings.length).toBe(1);
  expect(findings[0].subArea).toBe("default/sub/**");
});

test("parseFindings: malformed JSON → [] (never throws)", () => {
  expect(parseFindings("```json\n{not valid\n```", "s")).toEqual([]);
});

test("parseVerdicts: aligns by index and default-refutes any missing index", () => {
  const findings = [
    { title: "F0", description: "d", subArea: "s", confidence: 0.9, freezeSafe: true },
    { title: "F1", description: "d", subArea: "s", confidence: 0.9, freezeSafe: true },
  ];
  const out = '```json\n[{"index":0,"is_real":true,"confidence":0.95}]\n```'; // index 1 omitted
  const v = parseVerdicts(out, findings);
  expect(v[0]).toMatchObject({ isReal: true, confidence: 0.95 });
  expect(v[1]).toMatchObject({ isReal: false, confidence: 0 }); // default-refuted
});

test("parseVerdicts: unparseable → all default-refuted", () => {
  const findings = [{ title: "F0", description: "d", subArea: "s", confidence: 0.9, freezeSafe: true }];
  const v = parseVerdicts("garbage", findings);
  expect(v[0].isReal).toBe(false);
});

test("parseShaped: validates a single CompletableItem object, else null", () => {
  const ok =
    "```json\n" +
    JSON.stringify({
      title: "T",
      goal: "g",
      territory: ["a/**"],
      doneWhen: "green",
      status: "unclaimed",
      freezeSafe: true,
    }) +
    "\n```";
  expect(parseShaped(ok)?.title).toBe("T");
  expect(parseShaped('```json\n{"title":"only"}\n```')).toBeNull(); // missing required fields
});
