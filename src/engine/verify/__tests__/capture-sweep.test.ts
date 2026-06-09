import { test, expect } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  scanForTodos,
  scanForWrapUpCandidates,
  dedupeBySource,
  fingerprint,
  normalizeMarkerText,
  isExcluded,
  gatherSignals,
  runSweep,
  type SweepConfig,
} from "../../capture-sweep";
import { SWEEP } from "../../config";
import { parseQueue } from "../../queue";

const RE = SWEEP.markerRegex;

test("scanForTodos captures only the (tbw)-flagged marker, not bare TODO/FIXME", () => {
  const files = [
    {
      path: "a.ts",
      text: [
        "// TODO(tbw): wire the sweep",
        "// TODO: just a note", // bare → ignored
        "const x = 1; // FIXME(tbw): clamp this",
        "// FIXME: also ignored",
        "// HACK(tbw): not a recognised marker", // HACK not in regex → ignored
      ].join("\n"),
    },
  ];
  const c = scanForTodos(files, RE);
  expect(c.map((x) => x.title)).toEqual(["wire the sweep", "clamp this"]);
  expect(c.every((x) => x.origin === "auto")).toBe(true);
  expect(c[0]!.source).toBe(fingerprint("a.ts", "wire the sweep")); // provably present: scanForTodos returned 2 items
  expect(c[0]!.goal).toContain("a.ts:1");
});

test("fingerprint ignores line, whitespace, comment-prefix + case; file + wording matter", () => {
  expect(fingerprint("f.ts", "wire the sweep")).toBe(fingerprint("f.ts", "  wire   the sweep  "));
  expect(fingerprint("f.ts", "wire the sweep")).toBe(fingerprint("f.ts", "Wire The Sweep"));
  expect(fingerprint("a.ts", "x")).not.toBe(fingerprint("b.ts", "x")); // file is in the key
  expect(fingerprint("f.ts", "wire the sweep")).not.toBe(fingerprint("f.ts", "wire the sweep now")); // reworded
});

test("normalizeMarkerText strips trailing comment closers", () => {
  expect(normalizeMarkerText("do it */")).toBe("do it");
  expect(normalizeMarkerText("do it -->")).toBe("do it");
});

test("the same marker moving down a file keeps its fingerprint (line lives in goal, not source)", () => {
  const a = scanForTodos([{ path: "f.ts", text: "// TODO(tbw): same" }], RE);
  const b = scanForTodos([{ path: "f.ts", text: "\n\n\n// TODO(tbw): same" }], RE);
  expect(a[0]!.source).toBe(b[0]!.source); // both arrays have exactly 1 item
  expect(a[0]!.goal).toContain("f.ts:1");
  expect(b[0]!.goal).toContain("f.ts:4");
});

test("dedupeBySource collapses identical fingerprints, keeps first", () => {
  const c = scanForTodos([{ path: "f.ts", text: "// TODO(tbw): dup\n// TODO(tbw): dup" }], RE);
  expect(c).toHaveLength(2);
  expect(dedupeBySource(c)).toHaveLength(1);
});

test("isExcluded matches the post-scan reject globs", () => {
  expect(isExcluded("tools/x/node_modules/y.ts", SWEEP.excludeGlobs)).toBe(true);
  expect(isExcluded("tools/orchestrator/verify/__tests__/z.test.ts", SWEEP.excludeGlobs)).toBe(true);
  expect(isExcluded("tools/orchestrator/foo.test.ts", SWEEP.excludeGlobs)).toBe(true);
  expect(isExcluded("tools/orchestrator/capture-sweep.ts", SWEEP.excludeGlobs)).toBe(false);
});

test("gatherSignals walks scanGlobs, honours excludeGlobs, returns repo-relative paths", async () => {
  const root = join(tmpdir(), `sweep-${Math.random().toString(36).slice(2)}`);
  await Bun.write(join(root, "tools/keep.ts"), "// TODO(tbw): keep me");
  await Bun.write(join(root, "tools/skip.test.ts"), "// TODO(tbw): skip me"); // excluded
  await Bun.write(join(root, "tools/node_modules/dep.ts"), "// TODO(tbw): dep noise"); // excluded
  const cfg: SweepConfig = { ...SWEEP, scanGlobs: ["tools/**/*.ts"] };
  const c = await gatherSignals({ repoRoot: root, config: cfg });
  expect(c.map((x) => x.title)).toEqual(["keep me"]);
  expect(c[0]!.source).toContain("tools/keep.ts"); // provably present: 1 non-excluded file written
  await rm(root, { recursive: true, force: true });
});

test("gatherSignals over the real tools/ tree never enqueues the sweep's own source/tests", async () => {
  // __tests__ → verify → orchestrator → tools → repo root
  const repoRoot = resolve(import.meta.dir, "..", "..", "..", "..");
  const c = await gatherSignals({ repoRoot });
  for (const cand of c) {
    expect(cand.goal).not.toContain(".test.ts");
    expect(cand.goal).not.toContain("__tests__");
    expect(cand.goal).not.toContain("node_modules");
  }
});

test("scanForWrapUpCandidates harvests only engineering-flavored bullets (drops life + artifacts)", () => {
  const signal = SWEEP.wrapUpSignal;
  const files = [
    {
      path: "inbox/2026-06-04-wrap-up-candidates.md",
      text: [
        "## Session ending 16:00:00Z",
        "- going forward I'll suggest deep work before 11am", // life → dropped
        '- from now on I\'ll..." lines out of session transcripts).', // extractor artifact → dropped
        "- the smoke test is flaky on the tools surface — fix it", // engineering → harvested
        "## Session ending 16:30:00Z",
        "- the smoke test is flaky on the tools surface — fix it", // duplicate (other block)
        "regular prose mentioning a fix, not a bullet", // not a `- ` bullet → ignored
      ].join("\n"),
    },
  ];
  const c = scanForWrapUpCandidates(files, signal);
  expect(c).toHaveLength(2); // the two engineering occurrences (dedupe happens later)
  expect(c[0]!.title).toContain("smoke test is flaky"); // 2 items returned, index 0 provably present
  expect(c[0]!.source.startsWith("wrapup:")).toBe(true);
  expect(c[0]!.source).toBe(c[1]!.source); // identical text → identical fingerprint
  expect(c.every((x) => x.origin === "auto")).toBe(true);
  expect(dedupeBySource(c)).toHaveLength(1); // cross-session duplication collapses
});

test("scanForWrapUpCandidates skips a leading YAML frontmatter block (no list-item false-harvest)", () => {
  const files = [
    {
      path: "inbox/x-wrap-up-candidates.md",
      text: ["---", "- bug in a frontmatter sequence", "type: inbox", "---", "", "- fix the flaky test"].join("\n"),
    },
  ];
  const c = scanForWrapUpCandidates(files, SWEEP.wrapUpSignal);
  expect(c).toHaveLength(1); // the frontmatter `- bug` line is NOT harvested
  expect(c[0]!.title).toContain("fix the flaky test"); // 1 item returned (frontmatter bullet excluded)
});

test("gatherSignals merges TODO markers and engineering wrap-up bullets; drops life bullets", async () => {
  const root = join(tmpdir(), `sweep-${Math.random().toString(36).slice(2)}`);
  await Bun.write(join(root, "tools/x.ts"), "// TODO(tbw): wire the heartbeat ping");
  await Bun.write(
    join(root, "inbox/2026-01-01-wrap-up-candidates.md"),
    "## S\n- fix the flaky smoke test\n- buy groceries on the way home",
  );
  const cfg: SweepConfig = { ...SWEEP, scanGlobs: ["tools/**/*.ts"], wrapUpGlobs: ["inbox/*-wrap-up-candidates.md"] };
  const c = await gatherSignals({ repoRoot: root, config: cfg });
  const sources = c.map((x) => x.source);
  expect(sources.some((s) => s.startsWith("todo:"))).toBe(true);
  expect(sources.some((s) => s.startsWith("wrapup:"))).toBe(true);
  expect(c.find((x) => x.source.startsWith("wrapup:"))?.title).toContain("flaky smoke test");
  expect(c.some((x) => x.goal.includes("groceries"))).toBe(false); // life bullet not harvested
  await rm(root, { recursive: true, force: true });
});

test("runSweep --dry-run reports without writing; caps at maxPerSweep; re-sweep dedups", async () => {
  const root = join(tmpdir(), `sweep-${Math.random().toString(36).slice(2)}`);
  const queuePath = join(root, "queue.md");
  await Bun.write(queuePath, "# build queue\n");
  await Bun.write(join(root, "tools/x.ts"), "// TODO(tbw): one\n// TODO(tbw): two\n// TODO(tbw): three");
  const cfg: SweepConfig = { ...SWEEP, scanGlobs: ["tools/**/*.ts"], maxPerSweep: 2 };

  const dry = await runSweep({ repoRoot: root, queuePath, config: cfg, dryRun: true });
  expect(dry.appended).toHaveLength(2);
  expect(dry.skippedBudget).toHaveLength(1);
  expect(parseQueue(await Bun.file(queuePath).text())).toHaveLength(0); // nothing written

  const wet = await runSweep({ repoRoot: root, queuePath, config: cfg });
  expect(wet.appended).toHaveLength(2);
  const items = parseQueue(await Bun.file(queuePath).text());
  expect(items).toHaveLength(2);
  expect(items.every((i) => i.status === "needs-intake" && i.origin === "auto" && !!i.source)).toBe(true);

  // Second sweep with headroom: the 2 already-queued are skipped, the 3rd appends.
  const again = await runSweep({ repoRoot: root, queuePath, config: { ...cfg, maxPerSweep: 10 } });
  expect(again.appended).toHaveLength(1);
  expect(again.skippedExisting).toHaveLength(2);
  await rm(root, { recursive: true, force: true });
});
