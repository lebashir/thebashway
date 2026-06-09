import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { drain, type DrainDeps } from "../../drain";
import { parseQueue, type QueueItem } from "../../queue";
import { DRAIN_BREAKER } from "../../config";
import { DesignBriefSchema, type DesignBrief } from "../../brief";

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

// ---------------------------------------------------------------------------
// In-drain EARLY-STOP seam (spec 5.4): stopWhenBriefMet + briefSatisfied?/loadBrief?.
// Back-compat is critical — the seam is OPTIONAL; every test above runs WITHOUT it and stays
// green, proving "seam omitted => today's behavior."
// ---------------------------------------------------------------------------

// A minimal confirmed, terminable brief the loadBrief? fake returns.
function fakeBrief(): DesignBrief {
  return DesignBriefSchema.parse({
    confirmed: true,
    purpose: "p",
    whyNow: "w",
    whoServed: "o",
    scope: "s",
    limits: "l",
    successCriteria: [{ id: "tests", statement: "tests pass", check: { kind: "command", run: "true" }, required: true }],
    milestones: [],
  });
}

test("stopWhenBriefMet:true + briefSatisfied true after the first integrate => goalMet, loop breaks WITHOUT a new claim, landFn STILL runs on green", async () => {
  // Two claimable items. The early-stop fires after the FIRST integrate, so the second is never
  // claimed; what is green still LANDS via the unchanged landFn.
  const p = await writeQueue([
    itemBlock({ title: "First", territory: "tools/f/**" }),
    itemBlock({ title: "Second", territory: "tools/s/**" }),
  ]);
  const calls = mkCalls();
  let satisfiedCalls = 0;
  const report = await drain(
    { surface: "tools", queuePath: p, repoRoot: "/repo", noPreflight: true, session: "t", n: 10, stopWhenBriefMet: true, briefPath: "/repo/brief.ts" },
    mkDeps(
      {
        loadBrief: async () => ({ brief: fakeBrief(), status: "ok", errors: [] }),
        briefSatisfied: async () => {
          satisfiedCalls++;
          return true; // met after the first integrate
        },
      },
      calls,
    ),
  );
  expect(report.goalMet).toBe(true);
  expect(report.succeeded).toEqual(["First"]); // ONLY the first item — the loop broke before claiming Second
  expect(calls.basha).toEqual(["First"]); // Second never built
  expect(satisfiedCalls).toBe(1);
  // landFn still runs on green (the early-stop gates NEW CLAIMS, never the land of what is green).
  expect(report.landed).toBe(true);
  expect(calls.land).toEqual(["tbw/integration-tools->main"]);
  // Second is still claimable in the queue (never touched).
  const items = await readItems(p);
  expect(items.find((i) => i.title === "Second")?.status).toBe("unclaimed");
  cleanup(p);
});

test("stopWhenBriefMet:true but briefSatisfied false => no early stop, both items build (seam is opt-in and only stops when MET)", async () => {
  const p = await writeQueue([
    itemBlock({ title: "A1", territory: "tools/a1/**" }),
    itemBlock({ title: "A2", territory: "tools/a2/**" }),
  ]);
  const calls = mkCalls();
  const report = await drain(
    { surface: "tools", queuePath: p, repoRoot: "/repo", noPreflight: true, session: "t", n: 10, land: false, stopWhenBriefMet: true, briefPath: "/repo/brief.ts" },
    mkDeps(
      {
        loadBrief: async () => ({ brief: fakeBrief(), status: "ok", errors: [] }),
        briefSatisfied: async () => false,
      },
      calls,
    ),
  );
  expect(report.goalMet).toBeUndefined();
  expect(new Set(report.succeeded)).toEqual(new Set(["A1", "A2"]));
  cleanup(p);
});

test("targetCriteria on DrainOptions is threaded into briefSatisfied's target arg (the fake receives the expected Set)", async () => {
  const p = await writeQueue([itemBlock({ title: "T1", territory: "tools/t1/**" })]);
  const calls = mkCalls();
  let seenTarget: Set<string> | undefined;
  let seenIsSet = false;
  await drain(
    {
      surface: "tools",
      queuePath: p,
      repoRoot: "/repo",
      noPreflight: true,
      session: "t",
      land: false,
      stopWhenBriefMet: true,
      briefPath: "/repo/brief.ts",
      targetCriteria: ["alpha", "beta"],
    },
    mkDeps(
      {
        loadBrief: async () => ({ brief: fakeBrief(), status: "ok", errors: [] }),
        briefSatisfied: async (_brief, target) => {
          seenIsSet = target instanceof Set;
          seenTarget = target;
          return true;
        },
      },
      calls,
    ),
  );
  expect(seenIsSet).toBe(true);
  expect(seenTarget && [...seenTarget].sort()).toEqual(["alpha", "beta"]);
  cleanup(p);
});

test("the allowTitles (design-door) drain IGNORES stopWhenBriefMet — feature-atomic, never self-terminates on a global goal", async () => {
  // Two allowed titles; even though briefSatisfied would return true, the feature-isolated drain
  // never consults the early-stop seam, so BOTH build and briefSatisfied is never called.
  const p = await writeQueue([
    itemBlock({ title: "FeatOne", territory: "tools/fo/**" }),
    itemBlock({ title: "FeatTwo", territory: "tools/ft/**" }),
  ]);
  const calls = mkCalls();
  let satisfiedCalls = 0;
  const report = await drain(
    {
      surface: "tools",
      queuePath: p,
      repoRoot: "/repo",
      noPreflight: true,
      session: "t",
      n: 10,
      land: false,
      stopWhenBriefMet: true,
      briefPath: "/repo/brief.ts",
      claimTitles: ["FeatOne", "FeatTwo"],
    },
    mkDeps(
      {
        loadBrief: async () => ({ brief: fakeBrief(), status: "ok", errors: [] }),
        briefSatisfied: async () => {
          satisfiedCalls++;
          return true;
        },
      },
      calls,
    ),
  );
  expect(satisfiedCalls).toBe(0); // never consulted
  expect(report.goalMet).toBeUndefined();
  expect(new Set(report.succeeded)).toEqual(new Set(["FeatOne", "FeatTwo"])); // both built
  cleanup(p);
});

test("breaker still trips regardless of the early-stop seam (seam never bypasses shouldTrip)", async () => {
  const p = await writeQueue([
    itemBlock({ title: "X1", territory: "tools/x1/**" }),
    itemBlock({ title: "X2", territory: "tools/x2/**" }),
    itemBlock({ title: "X3", territory: "tools/x3/**" }),
  ]);
  const calls = mkCalls();
  const report = await drain(
    { surface: "tools", queuePath: p, repoRoot: "/repo", noPreflight: true, session: "t", n: 10, land: false, stopWhenBriefMet: true, briefPath: "/repo/brief.ts" },
    mkDeps(
      {
        runBasha: async (item, ctx) => ({ ok: false, branch: ctx.branch, reason: "boom" }),
        loadBrief: async () => ({ brief: fakeBrief(), status: "ok", errors: [] }),
        briefSatisfied: async () => true, // would early-stop on a SUCCESS, but there are no successes
      },
      calls,
    ),
  );
  expect(report.breakerTripped).toBe(true);
  expect(report.goalMet).toBeUndefined(); // early-stop only fires after a SUCCESSFUL integrate
  cleanup(p);
});

test("unsafeIntegrationBranch still aborts regardless of the early-stop seam", async () => {
  const p = await writeQueue([itemBlock({ title: "U1", territory: "tools/u/**" })]);
  const calls = mkCalls();
  const report = await drain(
    { surface: "tools", queuePath: p, repoRoot: "/repo", noPreflight: true, session: "t", integrationBranch: "main", stopWhenBriefMet: true, briefPath: "/repo/brief.ts" },
    mkDeps(
      {
        loadBrief: async () => ({ brief: fakeBrief(), status: "ok", errors: [] }),
        briefSatisfied: async () => true,
      },
      calls,
    ),
  );
  expect(report.aborted).toBeTruthy();
  expect(report.aborted).toContain("main");
  expect(calls.basha).toEqual([]); // nothing processed
  cleanup(p);
});

// ---------------------------------------------------------------------------
// Loop B capture seam: a basha-emitted LESSON is routed verbatim; a gate-detected failure
// (verify / non-mis-slice integration) synthesizes a [<surface>]-tagged lesson so it feeds
// forward. Plain build-fail without a basha lesson captures nothing.
// ---------------------------------------------------------------------------

test("Loop B: a basha-emitted LESSON on a DONE is routed verbatim through appendLessonFn", async () => {
  const p = await writeQueue([itemBlock({ title: "Lc1", territory: "tools/lc1/**" })]);
  const calls = mkCalls();
  const report = await drain(
    base(p),
    mkDeps({ runBasha: async (item, ctx) => { calls.basha.push(item.title); return { ok: true, branch: ctx.branch, lesson: "[tools] never X without Y" }; } }, calls),
  );
  expect(report.succeeded).toEqual(["Lc1"]); // captured AND still ships
  expect(calls.lessons).toEqual(["[tools] never X without Y"]);
  cleanup(p);
});

test("Loop B: a basha-emitted LESSON on a BLOCKED build is routed (item still @blocked)", async () => {
  const p = await writeQueue([itemBlock({ title: "Lc2", territory: "tools/lc2/**" })]);
  const calls = mkCalls();
  const report = await drain(
    base(p),
    mkDeps({ runBasha: async (_item, ctx) => ({ ok: false, branch: ctx.branch, reason: "stuck", lesson: "[tools] the API needs Z first" }) }, calls),
  );
  expect(report.blocked[0].item).toBe("Lc2");
  expect(calls.lessons).toEqual(["[tools] the API needs Z first"]); // routed once (not per retry)
  cleanup(p);
});

test("Loop B: a unit verify failure synthesizes a [<surface>]-tagged lesson", async () => {
  const p = await writeQueue([itemBlock({ title: "Lc3", territory: "tools/lc3/**" })]);
  const calls = mkCalls();
  await drain(
    base(p),
    mkDeps({ verifyUnit: async () => ({ ok: false, manifestHash: "-", reason: "red" }) }, calls),
  );
  expect(calls.lessons.length).toBe(1);
  expect(calls.lessons[0].startsWith("[tools]")).toBe(true); // surface tag → actually feeds forward
  expect(calls.lessons[0]).toContain("re-verify");
  cleanup(p);
});

test("Loop B: a non-mis-slice integration failure synthesizes a [<surface>]-tagged lesson", async () => {
  const p = await writeQueue([itemBlock({ title: "Lc4", territory: "tools/lc4/**" })]);
  const calls = mkCalls();
  await drain(
    base(p),
    mkDeps({ integrateUnit: async () => ({ ok: false, reason: "boom" }) }, calls), // misSlice falsy
  );
  expect(calls.lessons.length).toBe(1);
  expect(calls.lessons[0].startsWith("[tools]")).toBe(true);
  expect(calls.lessons[0]).toContain("integration re-verify failed");
  cleanup(p);
});

test("Loop B: the mis-slice lesson is re-tagged to the surface (keeps the `mis-slice` body)", async () => {
  const p = await writeQueue([itemBlock({ title: "Lc5", territory: "tools/lc5/**" })]);
  const calls = mkCalls();
  await drain(
    base(p),
    mkDeps({ integrateUnit: async () => ({ ok: false, reason: "scope conflict", misSlice: true }) }, calls),
  );
  expect(calls.lessons.length).toBe(1);
  expect(calls.lessons[0].startsWith("[tools]")).toBe(true); // was [integration] (never fed forward)
  expect(calls.lessons[0].toLowerCase()).toContain("mis-slice");
  cleanup(p);
});

test("Loop B: a plain build-fail with NO basha lesson captures nothing (no synth noise)", async () => {
  const p = await writeQueue([itemBlock({ title: "Lc6", territory: "tools/lc6/**" })]);
  const calls = mkCalls();
  await drain(
    base(p),
    mkDeps({ runBasha: async (_item, ctx) => ({ ok: false, branch: ctx.branch, reason: "compile error" }) }, calls),
  );
  expect(calls.lessons).toEqual([]); // build-fail is not synthesized (often transient)
  cleanup(p);
});
