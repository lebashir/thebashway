import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { drain, type DrainDeps } from "../../drain";
import { parseQueue, type QueueItem } from "../../queue";
import { DRAIN_BREAKER } from "../../config";

// ---------------------------------------------------------------------------
// Temp queue scaffolding — the loop runs against the REAL flock-guarded
// claimNextN/markDone/markBlocked, so we give it a real on-disk queue file.
// ---------------------------------------------------------------------------

const QHEADER = "# build queue\n\nThe shared work queue.\n";

function itemBlock(o: {
  title: string;
  status?: string;
  territory: string;
  auto?: boolean;
}): string {
  const tag = o.status ?? "@unclaimed";
  const origin = o.auto ? " (origin: auto)" : "";
  return [
    `- [ ] ${o.title}${origin}        ${tag}`,
    `  Goal: build ${o.title}`,
    `  Territory: ${o.territory}`,
    `  Done-when: verify green`,
  ].join("\n");
}

async function writeQueue(blocks: string[]): Promise<string> {
  const p = join(tmpdir(), `drain-q-${Math.random().toString(36).slice(2)}.md`);
  await Bun.write(p, `${QHEADER}\n${blocks.join("\n\n")}\n`);
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

// ---------------------------------------------------------------------------
// Recording fakes for the injected seams.
// ---------------------------------------------------------------------------

interface Calls {
  basha: string[];
  verify: string[];
  integrate: string[];
  notify: string[];
  lessons: string[];
  digests: string[];
  teardown: string[];
  land: string[];
  preflight: number;
}

function mkDeps(over: Partial<DrainDeps>, calls: Calls): DrainDeps {
  return {
    setupWorktree: async (item) => {
      return { worktree: `/tmp/wt/${item.title}` };
    },
    runBasha: async (item, ctx) => {
      calls.basha.push(item.title);
      return { ok: true, branch: ctx.branch };
    },
    verifyUnit: async (item) => {
      calls.verify.push(item.title);
      return { ok: true, manifestHash: "deadbeef" };
    },
    integrateUnit: async (item) => {
      calls.integrate.push(item.title);
      return { ok: true };
    },
    teardownWorktree: async (_wt, branch) => {
      calls.teardown.push(branch);
    },
    assertCleanFn: async () => ({ ok: true }),
    notify: async (text) => {
      calls.notify.push(text);
      return true;
    },
    landFn: async (integrationBranch, landBranch) => {
      calls.land.push(`${integrationBranch}->${landBranch}`);
      return { ok: true };
    },
    preflightFn: async () => {
      calls.preflight++;
      return { ok: true };
    },
    appendLessonFn: async (line) => {
      calls.lessons.push(line);
    },
    appendDigestFn: async (rec) => {
      calls.digests.push(rec.item);
    },
    ...over,
  };
}

function mkCalls(): Calls {
  return { basha: [], verify: [], integrate: [], notify: [], lessons: [], digests: [], teardown: [], land: [], preflight: 0 };
}

// land defaults true in the product; isolate the loop tests with land:false and cover
// the land step in dedicated tests below.
const base = (queuePath: string) => ({
  surface: "tools",
  queuePath,
  repoRoot: "/repo",
  noPreflight: true,
  session: "test",
  land: false,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("success path: builds, verifies, integrates, marks done, notifies (NOT deployed)", async () => {
  const p = await writeQueue([itemBlock({ title: "Alpha", territory: "tools/a/**" })]);
  const calls = mkCalls();
  const report = await drain(base(p), mkDeps({}, calls));

  expect(report.succeeded).toEqual(["Alpha"]);
  expect(report.blocked).toEqual([]);
  expect(report.breakerTripped).toBe(false);
  expect(report.integrationBranch).toBe("tbw/integration-tools");
  expect(calls.basha).toEqual(["Alpha"]);
  expect(calls.verify).toEqual(["Alpha"]);
  expect(calls.integrate).toEqual(["Alpha"]);
  // The item is now @done in the real queue.
  const items = await readItems(p);
  expect(items.find((i) => i.title === "Alpha")?.status).toBe("done");
  // land:false in base → staged at the integration branch, not landed.
  expect(calls.notify[0]).toContain("1 done");
  expect(calls.notify[0]).toContain("staged");
  expect(calls.land).toEqual([]);
  cleanup(p);
});

test("one-failure-retry: runBasha fails once then succeeds → item still ships", async () => {
  const p = await writeQueue([itemBlock({ title: "Beta", territory: "tools/b/**" })]);
  const calls = mkCalls();
  let n = 0;
  const report = await drain(
    base(p),
    mkDeps(
      {
        runBasha: async (item, ctx) => {
          calls.basha.push(item.title);
          n++;
          return n === 1 ? { ok: false, branch: ctx.branch, reason: "flaky" } : { ok: true, branch: ctx.branch };
        },
      },
      calls,
    ),
  );
  expect(report.succeeded).toEqual(["Beta"]);
  expect(calls.basha).toEqual(["Beta", "Beta"]); // retried once
  cleanup(p);
});

test("build fails twice → item @blocked, recorded, breaker sees one failure", async () => {
  const p = await writeQueue([itemBlock({ title: "Gamma", territory: "tools/g/**" })]);
  const calls = mkCalls();
  const report = await drain(
    base(p),
    mkDeps(
      { runBasha: async (item, ctx) => ({ ok: false, branch: ctx.branch, reason: "compile error" }) },
      calls,
    ),
  );
  expect(report.succeeded).toEqual([]);
  expect(report.blocked).toEqual([{ item: "Gamma", reason: "compile error" }]);
  const items = await readItems(p);
  expect(items.find((i) => i.title === "Gamma")?.status).toBe("blocked");
  cleanup(p);
});

test("breaker trips after maxFailures in window and halts further claims", async () => {
  // Three failing items; DRAIN_BREAKER = {maxFailures:2, window:3} trips after #2.
  const p = await writeQueue([
    itemBlock({ title: "F1", territory: "tools/f1/**" }),
    itemBlock({ title: "F2", territory: "tools/f2/**" }),
    itemBlock({ title: "F3", territory: "tools/f3/**" }),
  ]);
  const calls = mkCalls();
  const report = await drain(
    { ...base(p), n: 10 },
    mkDeps({ runBasha: async (item, ctx) => ({ ok: false, branch: ctx.branch, reason: "boom" }) }, calls),
  );
  expect(report.breakerTripped).toBe(true);
  // Only the first two failures were processed before the breaker stopped the loop.
  expect(report.blocked.map((b) => b.item)).toEqual(["F1", "F2"]);
  // F3 was never claimed (still unclaimed in the queue).
  const items = await readItems(p);
  expect(items.find((i) => i.title === "F3")?.status).toBe("unclaimed");
  expect(calls.notify[0]).toContain("BREAKER");
  cleanup(p);
});

test("integration re-verify failure with mis-slice → @blocked + Loop B lesson", async () => {
  const p = await writeQueue([itemBlock({ title: "Delta", territory: "tools/d/**" })]);
  const calls = mkCalls();
  const report = await drain(
    base(p),
    mkDeps(
      { integrateUnit: async () => ({ ok: false, reason: "scope conflict", misSlice: true }) },
      calls,
    ),
  );
  expect(report.succeeded).toEqual([]);
  expect(report.blocked[0].item).toBe("Delta");
  expect(calls.lessons.length).toBe(1);
  expect(calls.lessons[0].toLowerCase()).toContain("mis-slice");
  cleanup(p);
});

test("dry-run mutates NOTHING — no claim, no markDone, no basha", async () => {
  const p = await writeQueue([itemBlock({ title: "Echo", territory: "tools/e/**" })]);
  const before = await Bun.file(p).text();
  const calls = mkCalls();
  const report = await drain({ ...base(p), dryRun: true }, mkDeps({}, calls));
  const after = await Bun.file(p).text();
  expect(after).toBe(before); // file untouched
  expect(calls.basha).toEqual([]); // no build dispatched
  expect(report.claimed).toEqual(["Echo"]); // but reports what it WOULD claim
  cleanup(p);
});

test("unsafe integration branch (main) → aborted, no processing", async () => {
  const p = await writeQueue([itemBlock({ title: "Zeta", territory: "tools/z/**" })]);
  const calls = mkCalls();
  const report = await drain({ ...base(p), integrationBranch: "main" }, mkDeps({}, calls));
  expect(report.aborted).toBeTruthy();
  expect(report.aborted).toContain("main");
  expect(calls.basha).toEqual([]);
  // Also reject a non-tbw branch.
  const r2 = await drain({ ...base(p), integrationBranch: "feature/x" }, mkDeps({}, calls));
  expect(r2.aborted).toBeTruthy();
  cleanup(p);
});

test("autoBuild=false skips origin:auto items at claim; default builds them and counts them", async () => {
  const p = await writeQueue([
    itemBlock({ title: "Human1", territory: "tools/h/**" }),
    itemBlock({ title: "AutoFinding", territory: "tools/auto/**", auto: true }),
  ]);
  // autoBuild=false → only the human item builds.
  const c1 = mkCalls();
  const r1 = await drain({ ...base(p), autoBuild: false, n: 10 }, mkDeps({}, c1));
  expect(r1.claimed).toEqual(["Human1"]);
  expect(r1.autoBuiltCount).toBe(0);
  expect(c1.basha).toEqual(["Human1"]);
  cleanup(p);

  // Default (autoBuild=true) → both build, the origin:auto one is counted + surfaced.
  const p2 = await writeQueue([
    itemBlock({ title: "Human2", territory: "tools/h2/**" }),
    itemBlock({ title: "AutoFinding2", territory: "tools/auto2/**", auto: true }),
  ]);
  const c2 = mkCalls();
  const r2 = await drain({ ...base(p2), n: 10 }, mkDeps({}, c2));
  expect(new Set(r2.succeeded)).toEqual(new Set(["Human2", "AutoFinding2"]));
  expect(r2.autoBuiltCount).toBe(1);
  expect(c2.notify[0]).toContain("origin:auto");
  cleanup(p2);
});

test("surface filter: a drain claims ONLY its surface's items (no cross-surface build)", async () => {
  const p = await writeQueue([
    itemBlock({ title: "OrgItem", territory: "organs/src/x/**" }),
    itemBlock({ title: "ToolItem", territory: "tools/y/**" }),
  ]);
  const calls = mkCalls();
  const report = await drain({ ...base(p), surface: "tools", n: 10 }, mkDeps({}, calls));
  expect(report.claimed).toEqual(["ToolItem"]); // organs item NOT claimed by a tools drain
  expect(report.succeeded).toEqual(["ToolItem"]);
  const items = await readItems(p);
  expect(items.find((i) => i.title === "OrgItem")?.status).toBe("unclaimed");
  cleanup(p);

  // And dry-run respects the same filter.
  const p2 = await writeQueue([
    itemBlock({ title: "OrgItem2", territory: "organs/src/x/**" }),
    itemBlock({ title: "ToolItem2", territory: "tools/y/**" }),
  ]);
  const r2 = await drain({ ...base(p2), surface: "organs", n: 10, dryRun: true }, mkDeps({}, mkCalls()));
  expect(r2.claimed).toEqual(["OrgItem2"]); // organs dry-run sees only the organs item
  cleanup(p2);
});

test("preflight failure aborts the run before any claim", async () => {
  const p = await writeQueue([itemBlock({ title: "Theta", territory: "tools/t/**" })]);
  const calls = mkCalls();
  const report = await drain(
    { surface: "tools", queuePath: p, repoRoot: "/repo", session: "test" }, // preflight ON
    mkDeps({ preflightFn: async () => ({ ok: false, detail: "dirty tree" }) }, calls),
  );
  expect(report.aborted).toContain("preflight");
  expect(calls.basha).toEqual([]);
  cleanup(p);
});

test("DRAIN_BREAKER is the conservative two-in-three default", () => {
  expect(DRAIN_BREAKER.maxFailures).toBe(2);
  expect(DRAIN_BREAKER.window).toBe(3);
});

// ---------------------------------------------------------------------------
// Land step (default ON in the product): merge integration branch → main + push
// ---------------------------------------------------------------------------

test("land (default): a successful run merges the integration branch to main + pushes", async () => {
  const p = await writeQueue([itemBlock({ title: "L1", territory: "tools/l/**" })]);
  const calls = mkCalls();
  // land omitted → defaults to true.
  const report = await drain(
    { surface: "tools", queuePath: p, repoRoot: "/repo", noPreflight: true, session: "t" },
    mkDeps({}, calls),
  );
  expect(report.succeeded).toEqual(["L1"]);
  expect(report.landed).toBe(true);
  expect(calls.land).toEqual(["tbw/integration-tools->main"]);
  expect(calls.notify[0]).toContain("deployed (pushed to main)");
  cleanup(p);
});

test("land respects --land-branch and reports a failed push without throwing", async () => {
  const p = await writeQueue([itemBlock({ title: "L2", territory: "tools/l2/**" })]);
  const calls = mkCalls();
  const report = await drain(
    { surface: "tools", queuePath: p, repoRoot: "/repo", noPreflight: true, session: "t", landBranch: "release" },
    mkDeps({ landFn: async () => ({ ok: false, reason: "push blocked by classifier" }) }, calls),
  );
  expect(report.succeeded).toEqual(["L2"]);
  expect(report.landed).toBe(false);
  expect(report.landResult).toContain("LAND FAILED");
  expect(report.landResult).toContain("push blocked");
  cleanup(p);
});

test("land is SKIPPED on a breaker trip (nothing pushed after a failing run)", async () => {
  const p = await writeQueue([
    itemBlock({ title: "B1", territory: "tools/b1/**" }),
    itemBlock({ title: "B2", territory: "tools/b2/**" }),
  ]);
  const calls = mkCalls();
  const report = await drain(
    { surface: "tools", queuePath: p, repoRoot: "/repo", noPreflight: true, session: "t", n: 10 },
    mkDeps({ runBasha: async (i, c) => ({ ok: false, branch: c.branch, reason: "x" }) }, calls),
  );
  expect(report.breakerTripped).toBe(true);
  expect(report.landed).toBeUndefined();
  expect(calls.land).toEqual([]); // never pushed a failing run
  cleanup(p);
});

test("land is SKIPPED when nothing succeeded", async () => {
  const p = await writeQueue([itemBlock({ title: "N1", territory: "tools/n/**" })]);
  const calls = mkCalls();
  const report = await drain(
    { surface: "tools", queuePath: p, repoRoot: "/repo", noPreflight: true, session: "t" },
    mkDeps({ verifyUnit: async () => ({ ok: false, manifestHash: "-", reason: "red" }) }, calls),
  );
  expect(report.succeeded).toEqual([]);
  expect(calls.land).toEqual([]);
  cleanup(p);
});
