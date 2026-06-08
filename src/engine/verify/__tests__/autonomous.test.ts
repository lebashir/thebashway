// src/engine/verify/__tests__/autonomous.test.ts
// The FULL runToGoal part-or-all targeting matrix (spec 5.4, 8d). Every path runs with INJECTED
// FAKE deps — fake loadBrief / evaluateCheckSpec / runDrain / runAudit / notify / emitPark / now.
// NOTHING is spawned; the reducer (goalMet) and the evaluator (evaluateCheckSpec) are tested
// elsewhere. INV-A: runToGoal performs ZERO writes to briefPath across all paths (asserted via a
// spy on Bun.write / writeFileSync against the brief path).
import { test, expect, spyOn } from "bun:test";
import * as nodeFs from "node:fs";
import { runToGoal, type RunToGoalDeps, type RunToGoalOptions } from "../../autonomous";
import { DesignBriefSchema, type DesignBrief, type CheckSpec } from "../../brief";
import type { LoadBriefResult } from "../../load-brief";
import type { DrainReport } from "../../drain";
import type { AuditReport } from "../../audit-run";

// ---------------------------------------------------------------------------
// Brief fixture — a confirmed, terminable brief whose criteria ids the tests target.
// ---------------------------------------------------------------------------
function makeBrief(overrides: Partial<Record<string, unknown>> = {}): DesignBrief {
  return DesignBriefSchema.parse({
    confirmed: true,
    purpose: "p",
    whyNow: "w",
    whoServed: "o",
    scope: "s",
    limits: "l",
    successCriteria: [
      { id: "r1", statement: "required one", check: { kind: "command", run: "true" }, required: true },
      { id: "r2", statement: "required two", check: { kind: "command", run: "true" }, required: true },
      { id: "opt", statement: "optional doc", check: { kind: "file-exists", path: "DOC.md" }, required: false },
    ],
    milestones: [],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Fake-deps harness. `passing` maps criterion id -> pass/fail, and can be a per-iteration
// SEQUENCE (consumed each evalTarget round) to model "build moves the needle".
// ---------------------------------------------------------------------------
interface Harness {
  deps: RunToGoalDeps;
  notifies: string[];
  parks: { title: string; reason: string }[];
  drainCalls: { surface: string; stopWhenBriefMet?: boolean; targetCriteria?: string[] }[];
  auditCalls: number;
}

function mkHarness(cfg: {
  brief?: DesignBrief;
  loadStatus?: LoadBriefResult["status"];
  loadErrors?: string[];
  // pass-state per criterion id. A function lets the test return a fresh state each eval round.
  passing: (round: number) => Record<string, boolean>;
  // drain report per iteration (default: 1 succeeded, queue not empty).
  drain?: (iter: number) => Partial<DrainReport>;
  audit?: Partial<AuditReport>;
  nowSeq?: number[]; // successive now() values
}): Harness {
  const notifies: string[] = [];
  const parks: { title: string; reason: string }[] = [];
  const drainCalls: Harness["drainCalls"] = [];
  let auditCalls = 0;
  let evalRound = 0;
  let drainIter = 0;
  let nowIdx = 0;

  const status = cfg.loadStatus ?? "ok";
  // A SINGLE brief instance so evaluateCheckSpec can resolve each criterion's check object back to
  // its id via the WeakMap (the same object instances runToGoal evaluates).
  const theBrief = cfg.brief ?? makeBrief();
  const specIds = new WeakMap<object, string>();
  for (const c of theBrief.successCriteria) specIds.set(c.check as object, c.id);

  const loadResult: LoadBriefResult =
    status === "ok"
      ? { brief: theBrief, status: "ok", errors: [] }
      : status === "absent"
        ? { brief: null, status: "absent", errors: [] }
        : { brief: null, status: "unparseable", errors: cfg.loadErrors ?? ["boom"] };

  const deps: RunToGoalDeps = {
    loadBrief: async () => loadResult,
    evaluateCheckSpec: async (spec: CheckSpec) => {
      // Map the spec back to its criterion via the brief's run/path identity is brittle; instead
      // the fixture's criteria are evaluated in evalTarget order, so we resolve by a per-round
      // snapshot keyed on the spec's discriminant + a counter is unnecessary: the harness's
      // `passing(round)` returns the full id->bool map and runToGoal asks per id. We thread the id
      // through a WeakMap set up below.
      const id = specIds.get(spec);
      const map = cfg.passing(evalRound);
      return { pass: id ? map[id] === true : false };
    },
    evalCtx: { repoRoot: "/repo", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
    runDrain: async (o) => {
      drainCalls.push({ surface: o.surface, stopWhenBriefMet: o.stopWhenBriefMet, targetCriteria: o.targetCriteria });
      const partial = cfg.drain ? cfg.drain(drainIter) : {};
      drainIter++;
      // After a drain runs, the NEXT evalTarget reads the next round.
      evalRound++;
      return {
        ranPreflight: false,
        claimed: partial.claimed ?? ["x"],
        succeeded: partial.succeeded ?? ["x"],
        blocked: partial.blocked ?? [],
        autoBuiltCount: 0,
        breakerTripped: partial.breakerTripped ?? false,
        integrationBranch: "tbw/integration-tools",
        digests: [],
        summaryLines: [],
        ...partial,
      };
    },
    runAudit: async () => {
      auditCalls++;
      return {
        plan: { surface: "tools", rootGlob: "tools/**", subAreas: [] } as unknown as AuditReport["plan"],
        findingCount: 0,
        confirmedCount: 0,
        shaped: [],
        droppedOverCap: 0,
        downgradedLowConfidence: 0,
        enqueued: cfg.audit?.enqueued ?? null,
        ...cfg.audit,
      };
    },
    notify: async (t) => {
      notifies.push(t);
      return true;
    },
    emitPark: async (title, reason) => {
      parks.push({ title, reason });
    },
    now: () => {
      const seq = cfg.nowSeq;
      if (!seq) return 0;
      const v = seq[Math.min(nowIdx, seq.length - 1)];
      nowIdx++;
      return v;
    },
  };

  return { deps, notifies, parks, drainCalls, get auditCalls() { return auditCalls; } } as Harness;
}

const baseOpts = (over: Partial<RunToGoalOptions> = {}): RunToGoalOptions => ({
  surface: "tools",
  queuePath: "/repo/.thebashway/queue.md",
  repoRoot: "/repo",
  briefPath: "/repo/.thebashway/brief.ts",
  ...over,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("unknown targetCriteria id => 'invalid-target', NO drain, notify (typed, not a throw)", async () => {
  const h = mkHarness({ passing: () => ({ r1: false, r2: false, opt: false }) });
  const r = await runToGoal(baseOpts({ targetCriteria: ["r1", "nope"] }), h.deps);
  expect(r.reason).toBe("invalid-target");
  expect(r.goalMet).toBe(false);
  expect(h.drainCalls.length).toBe(0); // refuse-to-run
  expect(h.notifies.join(" ")).toContain("nope");
});

test("omitted targetCriteria + full required pass after a drain => 'goal-fully-met'", async () => {
  // entry: r1/r2 fail; after one drain: r1/r2 pass.
  const rounds = [
    { r1: false, r2: false, opt: false }, // entry eval
    { r1: true, r2: true, opt: false }, // after drain 1
  ];
  const h = mkHarness({ passing: (round) => rounds[Math.min(round, rounds.length - 1)] });
  const r = await runToGoal(baseOpts(), h.deps);
  expect(r.reason).toBe("goal-fully-met");
  expect(r.goalMet).toBe(true);
  expect(r.target.sort()).toEqual(["r1", "r2"]); // all REQUIRED ids (opt excluded)
  expect(r.failingRequired).toEqual([]);
  expect(h.drainCalls.length).toBe(1);
  // the drain pass threaded the early-stop seam + the full required target.
  expect(h.drainCalls[0].stopWhenBriefMet).toBe(true);
  expect(h.drainCalls[0].targetCriteria?.sort()).toEqual(["r1", "r2"]);
});

test("explicit targetCriteria:[] => refuse-to-run, no spin, 'target-has-no-required-criterion'", async () => {
  const h = mkHarness({ passing: () => ({ r1: true, r2: true, opt: true }) });
  const r = await runToGoal(baseOpts({ targetCriteria: [] }), h.deps);
  expect(r.reason).toBe("target-has-no-required-criterion");
  expect(r.goalMet).toBe(false);
  expect(h.drainCalls.length).toBe(0);
});

test("strict-subset slice met => 'target-slice-met' (NOT goal-fully-met); notify enumerates still-failing REQUIRED", async () => {
  // Target only {r1}. After a drain r1 passes; r2 stays red (still a failing REQUIRED criterion).
  const rounds = [
    { r1: false, r2: false, opt: false },
    { r1: true, r2: false, opt: false },
  ];
  const h = mkHarness({ passing: (round) => rounds[Math.min(round, rounds.length - 1)] });
  const r = await runToGoal(baseOpts({ targetCriteria: ["r1"] }), h.deps);
  expect(r.reason).toBe("target-slice-met");
  expect(r.reason).not.toBe("goal-fully-met");
  expect(r.goalMet).toBe(true);
  // r2 is a required criterion outside the slice and still red.
  expect(r.failingRequired).toEqual(["r2"]);
  expect(h.notifies.some((n) => n.includes("r2") && /slice/i.test(n))).toBe(true);
});

test("target of only required:false ids, all passing => refuse success 'target-has-no-required-criterion'", async () => {
  // aim at {opt} (required:false). Even though it passes, refuse to report a win.
  const h = mkHarness({ passing: () => ({ r1: false, r2: false, opt: true }) });
  const r = await runToGoal(baseOpts({ targetCriteria: ["opt"] }), h.deps);
  expect(r.reason).toBe("target-has-no-required-criterion");
  expect(r.goalMet).toBe(false);
  expect(h.drainCalls.length).toBe(0); // refused before any spin
  expect(h.notifies.join(" ")).toMatch(/required/i);
});

test("a slice already satisfied at entry => 'already-satisfied', built:0 even though untargeted criteria fail", async () => {
  // Target {r1}; r1 passes at entry, r2 (untargeted required) fails.
  const h = mkHarness({ passing: () => ({ r1: true, r2: false, opt: false }) });
  const r = await runToGoal(baseOpts({ targetCriteria: ["r1"] }), h.deps);
  expect(r.reason).toBe("already-satisfied");
  expect(r.goalMet).toBe(true);
  expect(r.built).toBe(0);
  expect(h.drainCalls.length).toBe(0); // no drain spun
});

test("maxIterations cap => 'cap-hit'", async () => {
  // Target {r1, opt}: r1 (required) never passes so the goal is never met, but opt flips each
  // round so the TARGET passing-set CHANGES — no-progress never trips and we hit the iteration cap.
  const passing = (round: number) => ({ r1: false, r2: false, opt: round % 2 === 0 });
  const h = mkHarness({ passing });
  const r = await runToGoal(baseOpts({ targetCriteria: ["r1", "opt"], maxIterations: 3 }), h.deps);
  expect(r.reason).toBe("cap-hit");
  expect(r.goalMet).toBe(false);
  expect(r.iterations).toBe(3);
  expect(h.drainCalls.length).toBe(3);
});

test("no-progress (target passing-set unchanged) => stop after K=2 stalls", async () => {
  // The target passing-set never changes across iterations: r1 stuck false, r2 stuck false.
  const h = mkHarness({ passing: () => ({ r1: false, r2: false, opt: false }) });
  const r = await runToGoal(baseOpts({ maxIterations: 10 }), h.deps);
  expect(r.reason).toBe("no-progress");
  expect(r.goalMet).toBe(false);
  // K=2: prev set captured after iter1; iter2 same => stall 1; iter3 same => stall 2 => stop.
  expect(r.iterations).toBe(3);
});

test("ANY milestones entry NEVER reports goal-fully-met/target-slice-met — always machine-criteria-met-pending-human + park (milestone outranks target), even for a pure-command slice", async () => {
  const briefWithMilestone = makeBrief({
    milestones: [{ statement: "UX feels fast", humanJudged: true }],
  });
  // Target the pure-command slice {r1}, unrelated to the milestone; r1 passes at entry.
  const h = mkHarness({
    brief: briefWithMilestone,
    passing: () => ({ r1: true, r2: true, opt: true }),
  });
  const r = await runToGoal(baseOpts({ targetCriteria: ["r1"] }), h.deps);
  expect(r.reason).toBe("machine-criteria-met-pending-human");
  expect(r.reason).not.toBe("goal-fully-met");
  expect(r.reason).not.toBe("target-slice-met");
  expect(r.goalMet).toBe(false);
  expect(h.parks.length).toBe(1); // parked for the human
});

test("unconfirmed brief => 'brief-unconfirmed', count-bounded, never terminates even with a valid targetCriteria (unconfirmed outranks targeting)", async () => {
  const draft = makeBrief({ confirmed: false });
  const h = mkHarness({ brief: draft, passing: () => ({ r1: true, r2: true, opt: true }) });
  // a perfectly valid target slice cannot terminate an unconfirmed brief.
  const r = await runToGoal(baseOpts({ targetCriteria: ["r1", "r2"] }), h.deps);
  expect(r.reason).toBe("brief-unconfirmed");
  expect(r.goalMet).toBe(false);
  // count-bounded fallback ran ONE drain (no early-stop seam).
  expect(h.drainCalls.length).toBe(1);
  expect(h.drainCalls[0].stopWhenBriefMet).toBeUndefined();
  expect(h.notifies.join(" ")).toMatch(/unconfirmed/i);
});

test("unparseable brief => loud signal (emitPark + notify), NO run", async () => {
  const h = mkHarness({ loadStatus: "unparseable", loadErrors: ["bad export"], passing: () => ({}) });
  const r = await runToGoal(baseOpts(), h.deps);
  expect(r.goalMet).toBe(false);
  expect(h.parks.length).toBe(1);
  expect(h.parks[0].title).toMatch(/unparseable/i);
  expect(h.drainCalls.length).toBe(0); // NO run
});

test("queue empties with target unmet + work-bridge audit produces nothing claimable => 'queue-empty-goal-unmet'", async () => {
  // The drain claims nothing (queue empty); the audit enqueues nothing.
  const h = mkHarness({
    passing: () => ({ r1: false, r2: false, opt: false }),
    drain: () => ({ claimed: [], succeeded: [] }),
    audit: { enqueued: null },
  });
  const r = await runToGoal(baseOpts(), h.deps);
  expect(r.reason).toBe("queue-empty-goal-unmet");
  expect(h.auditCalls).toBe(1); // exactly one targeted work-bridge pass
});

test("cap-hit with a CONSTANT failing-required set across the run => notify flags likely unsatisfiable/over-specified target", async () => {
  // Target {r2, opt}: r2 (required) is structurally unreachable (always false) so the failing-
  // REQUIRED set is the constant {r2} every round; opt flips so the TARGET passing-set CHANGES
  // (no-progress never trips) and we stop only at the iteration cap.
  const passing = (round: number) => ({ r1: false, r2: false, opt: round % 2 === 0 });
  const h = mkHarness({ passing });
  const r = await runToGoal(baseOpts({ targetCriteria: ["r2", "opt"], maxIterations: 3 }), h.deps);
  expect(r.reason).toBe("cap-hit");
  expect(r.failingRequired).toEqual(["r2"]);
  expect(h.notifies.some((n) => /unsatisfiable|over-specified/i.test(n))).toBe(true);
});

test("costCeiling bites INDEPENDENTLY of maxIterations — cap-hit on the build-basha cost axis before the iteration cap", async () => {
  // costCeiling counts BUILD BASHAS spawned (cumulative claimed) — a distinct axis from iterations.
  // Each drain claims 2 items (=2 bashas); with costCeiling 3 and maxIterations 10 the cost rail
  // trips at the 3rd loop-top (4 spawned > 3), long before the iteration cap. Target {r1, opt} with
  // opt flipping keeps the TARGET passing-set changing so no-progress never pre-empts the cost cap.
  const passing = (round: number) => ({ r1: false, r2: false, opt: round % 2 === 0 });
  const h = mkHarness({ passing, drain: () => ({ claimed: ["a", "b"], succeeded: ["a", "b"] }) });
  const r = await runToGoal(baseOpts({ targetCriteria: ["r1", "opt"], maxIterations: 10, costCeiling: 3 }), h.deps);
  expect(r.reason).toBe("cap-hit");
  expect(r.iterations).toBe(2); // stopped on the COST axis (2 drains = 4 bashas), not at 10 iterations
  expect(h.drainCalls.length).toBe(2);
});

test("generic cap-hit (failing-required CHANGES across the run) => the GENERIC notify, NOT the unsatisfiable flag", async () => {
  // Target {r1, r2} both required; r1 flips so the failing-REQUIRED set changes round to round
  // (failingEverChanged) — the GENERIC cap-hit path, distinct from the constant-failing
  // 'unsatisfiable' branch. The goal is never met (r1 & r2 never both pass) so we stop at the cap.
  const rounds = [
    { r1: true, r2: false, opt: false }, // entry: failing-required [r2]
    { r1: false, r2: false, opt: false }, // after drain1: [r1, r2] (CHANGED)
    { r1: true, r2: false, opt: false }, // after drain2: [r2]
    { r1: false, r2: false, opt: false }, // after drain3: [r1, r2]
  ];
  const h = mkHarness({ passing: (round) => rounds[Math.min(round, rounds.length - 1)] });
  const r = await runToGoal(baseOpts({ targetCriteria: ["r1", "r2"], maxIterations: 3 }), h.deps);
  expect(r.reason).toBe("cap-hit");
  expect(h.notifies.some((n) => /unsatisfiable|over-specified/i.test(n))).toBe(false);
  expect(h.notifies.some((n) => /cap hit after/i.test(n))).toBe(true); // the generic cap-hit notify
});

test("drain breaker trip propagates to the 'breaker-tripped' terminal reason", async () => {
  const h = mkHarness({
    passing: () => ({ r1: false, r2: false, opt: false }),
    drain: () => ({ breakerTripped: true, claimed: ["x"], succeeded: [] }),
  });
  const r = await runToGoal(baseOpts(), h.deps);
  expect(r.reason).toBe("breaker-tripped");
  expect(r.goalMet).toBe(false);
  expect(h.drainCalls.length).toBe(1); // halted after the first tripping drain
});

test("INV-A: runToGoal performs ZERO writes to briefPath across all paths (spy the brief path)", async () => {
  // Spy node:fs writeFileSync + Bun.write; assert NEITHER is ever called with the brief path,
  // across a representative spread of terminal reasons (goal-fully-met, milestone-park, unparseable).
  const briefPath = "/repo/.thebashway/brief.ts";
  const wfsSpy = spyOn(nodeFs, "writeFileSync").mockImplementation(() => {});
  const bunWriteSpy = spyOn(Bun, "write").mockImplementation(async () => 0);

  try {
    // goal-fully-met (entry fails, one drain, then both required pass)
    await runToGoal(
      baseOpts(),
      mkHarness({
        passing: (round) => [{ r1: false, r2: false, opt: false }, { r1: true, r2: true, opt: false }][Math.min(round, 1)],
      }).deps,
    );
    // milestone park path
    await runToGoal(
      baseOpts({ targetCriteria: ["r1"] }),
      mkHarness({
        brief: makeBrief({ milestones: [{ statement: "m", humanJudged: true }] }),
        passing: () => ({ r1: true, r2: true, opt: true }),
      }).deps,
    );
    // unparseable park path
    await runToGoal(baseOpts(), mkHarness({ loadStatus: "unparseable", passing: () => ({}) }).deps);

    const wroteBrief = (calls: unknown[][]) => calls.some((c) => typeof c[0] === "string" && (c[0] as string).includes(briefPath));
    expect(wroteBrief(wfsSpy.mock.calls)).toBe(false);
    expect(wroteBrief(bunWriteSpy.mock.calls)).toBe(false);
  } finally {
    wfsSpy.mockRestore();
    bunWriteSpy.mockRestore();
  }
});
