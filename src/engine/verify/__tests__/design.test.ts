import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import {
  surfaceRoles,
  classifyIrreversible,
  pathsOverlap,
  validateSurface,
  validateDepGraph,
  findDuplicateTitleIndices,
  FeatureDesignSchema,
  DecompositionSchema,
  DesignReviewSchema,
  type FeatureDesign,
  type DesignReview,
} from "../../design";
import {
  runFeatureDesign,
  parseFeatureDesign,
  parseDecomposition,
  parseDesignReview,
  type DesignDeps,
} from "../../design-run";
import type { CompletableItem } from "../../audit";
import { parseQueue, type QueueItem } from "../../queue";
import type { DrainReport } from "../../drain";
import { DesignBriefSchema, type DesignBrief } from "../../brief";
import type { LoadBriefResult } from "../../load-brief";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const QHEADER = "# build queue\n\nThe shared work queue.\n";
async function emptyQueue(): Promise<string> {
  const p = join(tmpdir(), `design-q-${Math.random().toString(36).slice(2)}.md`);
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

function fd(over: Partial<FeatureDesign> = {}): FeatureDesign {
  return { surface: "tools", surfaceRationale: "an automation", title: "Feature X", summary: "does X", openQuestions: [], ...over, affectsTerritory: over.affectsTerritory ?? [] };
}
function ci(over: Partial<CompletableItem> = {}): CompletableItem {
  return {
    title: "Task A",
    goal: "build A",
    territory: ["tools/orchestrator/a.ts"],
    doneWhen: "verify green",
    status: "unclaimed",
    freezeSafe: true,
    ...over,
  };
}
function review(over: Partial<DesignReview> = {}): DesignReview {
  return { designVerdict: "approve", required: [], taskVerdicts: [], ...over };
}
function drainReport(over: Partial<DrainReport> = {}): DrainReport {
  return {
    ranPreflight: false,
    claimed: ["Task A"],
    succeeded: ["Task A"],
    blocked: [],
    autoBuiltCount: 1,
    breakerTripped: false,
    integrationBranch: "tbw/integration-tools",
    digests: [],
    summaryLines: [],
    ...over,
  };
}

interface StubControl {
  designs: (FeatureDesign | null)[];
  tasks: CompletableItem[][];
  reviews: (DesignReview | null)[];
  drain?: DrainReport;
  landOk?: boolean;
  /** Inject a fake brief loader (phase b). When set, runFeatureDesign loads the brief ONCE. */
  loadBrief?: (briefPath: string) => Promise<LoadBriefResult>;
  /** Inject a fake Opus Tier-2 alignment refiner (phase b). */
  runAlignmentCheck?: (design: FeatureDesign, brief: DesignBrief) => Promise<{ material: boolean; reason?: string; offer?: string }>;
}
function stubDeps(c: StubControl) {
  const calls = {
    design: 0,
    decompose: 0,
    review: 0,
    drain: 0,
    land: 0,
    notify: [] as string[],
    drainAllowTitles: [] as string[],
    drainN: 0,
    loadBrief: 0,
    alignment: 0,
    designBriefs: [] as (DesignBrief | null | undefined)[],
    decomposeBriefs: [] as (DesignBrief | null | undefined)[],
  };
  const deps: DesignDeps = {
    async runDesign(_description, brief) {
      calls.designBriefs.push(brief);
      return c.designs[Math.min(calls.design++, c.designs.length - 1)] ?? null;
    },
    async runDecompose(_design, brief) {
      calls.decomposeBriefs.push(brief);
      return c.tasks[Math.min(calls.decompose++, c.tasks.length - 1)] ?? [];
    },
    async runReview() {
      return c.reviews[Math.min(calls.review++, c.reviews.length - 1)] ?? null;
    },
    async runDrainStaged(_surface, n, allowTitles) {
      calls.drain++;
      calls.drainN = n;
      calls.drainAllowTitles = allowTitles;
      return c.drain ?? drainReport();
    },
    async landIntegration() {
      calls.land++;
      return { ok: c.landOk ?? true };
    },
    async notify(t) {
      calls.notify.push(t);
    },
    ...(c.loadBrief
      ? {
          loadBrief: async (briefPath: string) => {
            calls.loadBrief++;
            return c.loadBrief!(briefPath);
          },
        }
      : {}),
    ...(c.runAlignmentCheck
      ? {
          runAlignmentCheck: async (design: FeatureDesign, brief: DesignBrief) => {
            calls.alignment++;
            return c.runAlignmentCheck!(design, brief);
          },
        }
      : {}),
  };
  return { deps, calls };
}

// A confirmed brief fixture for the phase-b alignment tests (one required `command` criterion so
// the .refine() passes; confirmed:true so classifyDrift's teeth are live).
function confirmedBrief(overrides: Partial<Record<string, unknown>> = {}): DesignBrief {
  return DesignBriefSchema.parse({
    confirmed: true,
    narrative: "prose",
    purpose: "p",
    whyNow: "n",
    whoServed: "w",
    scope: "s",
    limits: "l",
    inScopeSurfaces: [],
    forbiddenSurfaces: [],
    forbiddenTerritory: [],
    successCriteria: [{ id: "tests", statement: "tests pass", check: { kind: "command", run: "bun test" }, required: true }],
    milestones: [],
    ...overrides,
  });
}
const okLoad = (brief: DesignBrief): (() => Promise<LoadBriefResult>) => async () => ({ brief, status: "ok", errors: [] });

// ---------------------------------------------------------------------------
// Pure gates
// ---------------------------------------------------------------------------

test("surfaceRoles renders organs as secondary and tools as the default home", () => {
  const r = surfaceRoles();
  expect(r).toContain("tools:");
  expect(r).toContain("organs:");
  expect(r.toLowerCase()).toContain("default");
  expect(r.toLowerCase()).toContain("secondary");
});

test("pathsOverlap: equal, ancestor, descendant overlap; siblings do not", () => {
  expect(pathsOverlap("tools/google/**", "tools/google/**")).toBe(true);
  expect(pathsOverlap("tools/**", "tools/google/**")).toBe(true); // broad territory contains sensitive dir
  expect(pathsOverlap("tools/google/gmail.ts", "tools/google/**")).toBe(true);
  expect(pathsOverlap("tools/orchestrator/x.ts", "tools/google/**")).toBe(false);
});

test("classifyIrreversible: keyword, flag, and territory nets each trip; clean passes", () => {
  // keyword in goal
  expect(classifyIrreversible(ci({ goal: "send each person an email" }))).toBe(true);
  // keyword: destructive
  expect(classifyIrreversible(ci({ doneWhen: "old rows are deleted" }))).toBe(true);
  // explicit flag
  expect(classifyIrreversible(ci({ reachesPeople: true }))).toBe(true);
  expect(classifyIrreversible(ci({ destructive: true }))).toBe(true);
  // territory under a sensitive dir
  expect(classifyIrreversible(ci({ territory: ["tools/google/calendar.ts"] }))).toBe(true);
  // BLOCKER fix (break-it #1): a NEUTRAL-worded task editing a job that DELETES calendar
  // events was the proven bypass — now caught by the fail-safe tools/jobs/** directory rule.
  expect(classifyIrreversible(ci({
    title: "Support recurring rules in the calendar command",
    goal: "let the calendar command handle weekly recurrence",
    doneWhen: "a recurring rule round-trips",
    territory: ["tools/jobs/calendar-command.ts"],
  }))).toBe(true);
  // fail-safe over-park: even a benign-looking job (no keyword) is held — a NEW job is
  // person-reaching-by-default, the safe direction (one human glance, never auto-deploy).
  expect(classifyIrreversible(ci({ title: "Tweak the snapshot", goal: "round the figure", doneWhen: "green", territory: ["tools/jobs/networth-snapshot.ts"] }))).toBe(true);
  // extended keyword net (break-it #2): cancel + nudge now trip
  expect(classifyIrreversible(ci({ goal: "cancel the appointment", territory: ["tools/orchestrator/x.ts"] }))).toBe(true);
  expect(classifyIrreversible(ci({ goal: "nudge each overdue contact", territory: ["tools/orchestrator/x.ts"] }))).toBe(true);
  // broad territory CONTAINING a sensitive dir
  expect(classifyIrreversible(ci({ goal: "general work", territory: ["tools/**"] }))).toBe(true);
  // clean (orchestrator code, no keyword, not under a sensitive dir)
  expect(classifyIrreversible(ci({ title: "Add a parser", goal: "parse amounts", doneWhen: "verify green", territory: ["tools/orchestrator/parse.ts"] }))).toBe(false);
});

test("findDuplicateTitleIndices flags every task sharing a title", () => {
  expect(findDuplicateTitleIndices([ci({ title: "A" }), ci({ title: "B" }), ci({ title: "A" })])).toEqual([0, 2]);
  expect(findDuplicateTitleIndices([ci({ title: "A" }), ci({ title: "B" })])).toEqual([]);
});

test("validateSurface flags tasks whose territory is not under the surface dir", () => {
  const items = [ci({ territory: ["tools/a.ts"] }), ci({ territory: ["organs/x.tsx"] }), ci({ territory: ["tools/b.ts", "organs/c.tsx"] })];
  expect(validateSurface(items, "tools")).toEqual([1, 2]);
  expect(validateSurface(items, "organs")).toEqual([0, 2]);
});

test("validateDepGraph detects dangling refs and cycles", () => {
  // dangling: task 1 depends on a non-existent title
  const dangling = validateDepGraph([ci({ title: "A" }), ci({ title: "B", dependsOn: ["Nonexistent"] })]);
  expect(dangling.dangling).toEqual([1]);
  expect(dangling.cyclic).toEqual([]);
  // cycle: A → B → A
  const cyclic = validateDepGraph([ci({ title: "A", dependsOn: ["B"] }), ci({ title: "B", dependsOn: ["A"] })]);
  expect(cyclic.cyclic.sort()).toEqual([0, 1]);
  // clean chain: A → B (B first)
  const clean = validateDepGraph([ci({ title: "A", dependsOn: ["B"] }), ci({ title: "B" })]);
  expect(clean.dangling).toEqual([]);
  expect(clean.cyclic).toEqual([]);
});

// ---------------------------------------------------------------------------
// Schemas + parse helpers
// ---------------------------------------------------------------------------

test("schemas accept well-formed payloads", () => {
  expect(FeatureDesignSchema.safeParse(fd()).success).toBe(true);
  expect(DecompositionSchema.safeParse([ci()]).success).toBe(true);
  expect(DesignReviewSchema.safeParse(review({ taskVerdicts: [{ index: 0, buildReady: true, reason: "ok" }] })).success).toBe(true);
});

test("FeatureDesignSchema accepts affectsTerritory and defaults it to [] when absent (old outputs still parse)", () => {
  // a design output that DOES emit the new structured drift signal
  const withTerritory = FeatureDesignSchema.safeParse({
    surface: "tools",
    surfaceRationale: "an automation",
    title: "Feature X",
    summary: "does X",
    affectsTerritory: ["tools/orchestrator/x.ts", "tools/jobs/**"],
    openQuestions: [],
  });
  expect(withTerritory.success).toBe(true);
  if (withTerritory.success) expect(withTerritory.data.affectsTerritory).toEqual(["tools/orchestrator/x.ts", "tools/jobs/**"]);

  // a PRE-brief design output (no affectsTerritory field) still parses, defaulting to []
  const legacy = FeatureDesignSchema.safeParse({
    surface: "tools",
    surfaceRationale: "an automation",
    title: "Feature X",
    summary: "does X",
    openQuestions: [],
  });
  expect(legacy.success).toBe(true);
  if (legacy.success) expect(legacy.data.affectsTerritory).toEqual([]);
});

test("parse helpers pull fenced JSON and reject malformed", () => {
  const dBlock = "prose\n```json\n" + JSON.stringify(fd({ title: "Z" })) + "\n```\n";
  expect(parseFeatureDesign(dBlock)?.title).toBe("Z");
  expect(parseFeatureDesign("no json here")).toBeNull();

  const tBlock = "```json\n" + JSON.stringify([ci({ title: "T1" }), { bogus: true }]) + "\n```";
  const tasks = parseDecomposition(tBlock);
  expect(tasks.length).toBe(1); // salvages the valid item, drops the bogus one
  expect(tasks[0]?.title).toBe("T1");

  const rBlock = "```json\n" + JSON.stringify(review({ designVerdict: "revise", required: ["fix surface"] })) + "\n```";
  expect(parseDesignReview(rBlock)?.designVerdict).toBe("revise");
});

// ---------------------------------------------------------------------------
// runFeatureDesign — the seam pipeline
// ---------------------------------------------------------------------------

test("happy path (tools): design → decompose → approve → enqueue build-ready → drain → land", async () => {
  const q = await emptyQueue();
  const { deps, calls } = stubDeps({
    designs: [fd({ surface: "tools", title: "Amount parser" })],
    tasks: [[ci({ title: "Add parseAmount", territory: ["tools/orchestrator/parse.ts"] })]],
    reviews: [review({ taskVerdicts: [{ index: 0, buildReady: true, reason: "" }] })],
    drain: drainReport({ claimed: ["Add parseAmount"], succeeded: ["Add parseAmount"] }),
    landOk: true,
  });
  const report = await runFeatureDesign({ description: "parse amounts to fils", queuePath: q, repoRoot: ".", decisionsPath: "." }, deps);
  const items = await readItems(q);
  expect(items.find((i) => i.title === "Add parseAmount")?.status).toBe("unclaimed");
  expect(report.enqueued?.buildReady).toBe(1);
  expect(calls.drain).toBe(1);
  expect(report.landed).toBe(true);
  expect(report.summary).toContain("deployed");
  cleanup(q);
});

test("--no-land: a deployable (tools) feature builds + integrates but STAGES instead of deploying", async () => {
  const q = await emptyQueue();
  const { deps, calls } = stubDeps({
    designs: [fd({ surface: "tools", title: "Amount parser" })],
    tasks: [[ci({ title: "Add parseAmount", territory: ["tools/orchestrator/parse.ts"] })]],
    reviews: [review({ taskVerdicts: [{ index: 0, buildReady: true, reason: "" }] })],
    drain: drainReport({ claimed: ["Add parseAmount"], succeeded: ["Add parseAmount"] }),
    landOk: true,
  });
  const report = await runFeatureDesign(
    { description: "parse amounts to fils", queuePath: q, repoRoot: ".", decisionsPath: ".", noLand: true },
    deps,
  );
  expect(calls.drain).toBe(1); // still builds
  expect(calls.land).toBe(0); // ...but does NOT deploy
  expect(report.landed).toBe(false);
  expect(report.landResult).toContain("no-land");
  cleanup(q);
});

test("SAFETY: a person-reaching task is forced @needs-intake even when the cold review says build-ready and the run is freeze-authorized", async () => {
  const q = await emptyQueue();
  const { deps, calls } = stubDeps({
    designs: [fd({ surface: "tools", title: "Weekly digest emailer" })],
    // The decompose basha (wrongly) marks it build-ready; the LLM review also approves it.
    tasks: [[ci({ title: "Email everyone in people a weekly digest", goal: "send each person an email", territory: ["tools/jobs/digest.ts"], status: "unclaimed", freezeSafe: true })]],
    reviews: [review({ taskVerdicts: [{ index: 0, buildReady: true, reason: "looks fine" }] })],
  });
  const report = await runFeatureDesign(
    { description: "email people a weekly digest", queuePath: q, repoRoot: ".", decisionsPath: ".", freezeAuthorized: true },
    deps,
  );
  const items = await readItems(q);
  expect(items[0]?.status).toBe("needs-intake"); // deterministic gate overrides the LLM
  expect(items[0]?.openQuestion).toContain("reaches people");
  expect(report.gated.irreversible).toContain("Email everyone in people a weekly digest");
  expect(calls.drain).toBe(0); // nothing build-ready → no autonomous build
  cleanup(q);
});

test("organs surface builds but STAGES (never auto-deploys) — smoke can't exercise a new route", async () => {
  const q = await emptyQueue();
  const { deps, calls } = stubDeps({
    designs: [fd({ surface: "organs", title: "New insights organ", surfaceRationale: "a hub view the user asked for" })],
    tasks: [[ci({ title: "Add insights section", territory: ["organs/src/sections/insights/index.ts", "organs/src/registry.ts"], freezeSafe: false })]],
    reviews: [review({ taskVerdicts: [{ index: 0, buildReady: true, reason: "" }] })],
    drain: drainReport({ integrationBranch: "tbw/integration-organs", claimed: ["Add insights section"], succeeded: ["Add insights section"] }),
  });
  const report = await runFeatureDesign({ description: "add an insights organ", queuePath: q, repoRoot: ".", decisionsPath: ".", freezeAuthorized: true }, deps);
  // freeze-authorized → the new-UI task is build-ready (built), but organs never auto-lands.
  expect(report.enqueued?.buildReady).toBe(1);
  expect(calls.drain).toBe(1);
  expect(calls.land).toBe(0);
  expect(report.landed).toBe(false);
  expect(report.landResult).toContain("staged");
  cleanup(q);
});

test("a blocked feature member holds the land (no half-built deploy)", async () => {
  const q = await emptyQueue();
  const { deps, calls } = stubDeps({
    designs: [fd({ surface: "tools", title: "Two-part tool" })],
    tasks: [[ci({ title: "Part 1", territory: ["tools/orchestrator/p1.ts"] }), ci({ title: "Part 2", territory: ["tools/orchestrator/p2.ts"] })]],
    reviews: [review({ taskVerdicts: [{ index: 0, buildReady: true }, { index: 1, buildReady: true }] })],
    drain: drainReport({ claimed: ["Part 1", "Part 2"], succeeded: ["Part 1"], blocked: [{ item: "Part 2", reason: "verify failed" }] }),
  });
  const report = await runFeatureDesign({ description: "two part tool", queuePath: q, repoRoot: ".", decisionsPath: "." }, deps);
  expect(calls.drain).toBe(1);
  expect(calls.land).toBe(0); // blocked member → stage, do not deploy
  expect(report.landed).toBe(false);
  expect(report.landResult).toContain("blocked");
  cleanup(q);
});

test("all-ambiguous decomposition enqueues @needs-intake and never drains", async () => {
  const q = await emptyQueue();
  const { deps, calls } = stubDeps({
    designs: [fd({ surface: "tools", title: "Fuzzy feature" })],
    tasks: [[ci({ title: "Unclear task", status: "needs-intake", openQuestion: "what exactly?" })]],
    reviews: [review({ taskVerdicts: [{ index: 0, buildReady: false, reason: "ambiguous" }] })],
  });
  const report = await runFeatureDesign({ description: "do something vague", queuePath: q, repoRoot: ".", decisionsPath: "." }, deps);
  expect(report.enqueued?.buildReady).toBe(0);
  expect(calls.drain).toBe(0);
  expect(report.summary).toContain("need input");
  cleanup(q);
});

test("review 'revise' bounces the design once (re-design + re-decompose)", async () => {
  const q = await emptyQueue();
  const { deps, calls } = stubDeps({
    designs: [fd({ surface: "organs", title: "v1 wrong surface" }), fd({ surface: "tools", title: "v2 right surface" })],
    tasks: [
      [ci({ title: "wrong", territory: ["organs/x.tsx"] })],
      [ci({ title: "right", territory: ["tools/orchestrator/x.ts"] })],
    ],
    reviews: [review({ designVerdict: "revise", required: ["wrong surface"] }), review({ taskVerdicts: [{ index: 0, buildReady: true }] })],
    drain: drainReport({ claimed: ["right"], succeeded: ["right"] }),
  });
  const report = await runFeatureDesign({ description: "x", queuePath: q, repoRoot: ".", decisionsPath: "." }, deps);
  expect(calls.design).toBe(2); // bounced once
  expect(report.design?.title).toBe("v2 right surface");
  expect(report.surface).toBe("tools");
  cleanup(q);
});

test("over-cap decomposition aborts and writes nothing", async () => {
  const q = await emptyQueue();
  const many = Array.from({ length: 13 }, (_, i) => ci({ title: `T${i}`, territory: [`tools/orchestrator/t${i}.ts`] }));
  const { deps, calls } = stubDeps({
    designs: [fd({ surface: "tools" })],
    tasks: [many],
    reviews: [review()],
  });
  const report = await runFeatureDesign({ description: "huge", queuePath: q, repoRoot: ".", decisionsPath: ".", maxTasks: 12 }, deps);
  expect(report.aborted).toContain("too large");
  expect(calls.drain).toBe(0);
  expect((await readItems(q)).length).toBe(0);
  cleanup(q);
});

test("a dangling dependency forces only the dependent to @needs-intake", async () => {
  const q = await emptyQueue();
  const { deps } = stubDeps({
    designs: [fd({ surface: "tools", title: "chain" })],
    tasks: [[
      ci({ title: "Migration", territory: ["tools/orchestrator/m.ts"] }),
      ci({ title: "Reader", territory: ["tools/orchestrator/r.ts"], dependsOn: ["Mygration"] }), // typo'd dep
    ]],
    reviews: [review({ taskVerdicts: [{ index: 0, buildReady: true }, { index: 1, buildReady: true }] })],
    drain: drainReport({ claimed: ["Migration"], succeeded: ["Migration"] }),
  });
  const report = await runFeatureDesign({ description: "chain", queuePath: q, repoRoot: ".", decisionsPath: "." }, deps);
  const items = await readItems(q);
  expect(items.find((i) => i.title === "Migration")?.status).toBe("unclaimed");
  expect(items.find((i) => i.title === "Reader")?.status).toBe("needs-intake");
  expect(report.gated.danglingDep).toContain("Reader");
  cleanup(q);
});

test("dry-run designs + reports without enqueueing or draining", async () => {
  const q = await emptyQueue();
  const { deps, calls } = stubDeps({
    designs: [fd({ surface: "tools", title: "Preview" })],
    tasks: [[ci({ title: "Task A" })]],
    reviews: [review({ taskVerdicts: [{ index: 0, buildReady: true }] })],
  });
  const report = await runFeatureDesign({ description: "preview only", queuePath: q, repoRoot: ".", decisionsPath: ".", dryRun: true }, deps);
  expect(report.enqueued?.appended).toBe(0);
  expect(report.summary).toContain("dry-run");
  expect(calls.drain).toBe(0);
  expect((await readItems(q)).length).toBe(0);
  cleanup(q);
});

test("FEATURE ISOLATION: the chained drain receives only this feature's build-ready titles as the allow-list", async () => {
  const q = await emptyQueue();
  // Pre-existing unrelated build-ready item already in the queue.
  await Bun.write(q, `${QHEADER}\n- [ ] Pre-existing unrelated item        @unclaimed\n  Goal: something else\n  Territory: tools/orchestrator/other.ts\n  Done-when: green\n`);
  const { deps, calls } = stubDeps({
    designs: [fd({ surface: "tools", title: "My feature" })],
    tasks: [[ci({ title: "Feature task 1", territory: ["tools/orchestrator/f1.ts"] }), ci({ title: "Feature task 2", territory: ["tools/orchestrator/f2.ts"] })]],
    reviews: [review({ taskVerdicts: [{ index: 0, buildReady: true }, { index: 1, buildReady: true }] })],
    drain: drainReport({ claimed: ["Feature task 1", "Feature task 2"], succeeded: ["Feature task 1", "Feature task 2"] }),
  });
  await runFeatureDesign({ description: "my feature", queuePath: q, repoRoot: ".", decisionsPath: "." }, deps);
  expect(calls.drainAllowTitles.sort()).toEqual(["Feature task 1", "Feature task 2"]);
  expect(calls.drainAllowTitles).not.toContain("Pre-existing unrelated item"); // never folds in unrelated work
  cleanup(q);
});

test("CASCADE: a build-ready task depending on a gated (person-reaching) sibling is itself held @needs-intake", async () => {
  const q = await emptyQueue();
  const { deps, calls } = stubDeps({
    designs: [fd({ surface: "tools", title: "Notifier feature" })],
    tasks: [[
      ci({ title: "Add the send job", goal: "email each person", territory: ["tools/jobs/notifier.ts"] }), // person-reaching → gated
      ci({ title: "Add the UI toggle", goal: "a settings toggle", territory: ["tools/orchestrator/toggle.ts"], dependsOn: ["Add the send job"] }), // clean, but depends on the gated one
    ]],
    reviews: [review({ taskVerdicts: [{ index: 0, buildReady: true }, { index: 1, buildReady: true }] })],
  });
  const report = await runFeatureDesign({ description: "notifier", queuePath: q, repoRoot: ".", decisionsPath: "." }, deps);
  const items = await readItems(q);
  expect(items.find((i) => i.title === "Add the send job")?.status).toBe("needs-intake"); // irreversible gate
  expect(items.find((i) => i.title === "Add the UI toggle")?.status).toBe("needs-intake"); // cascaded, NOT silently stranded
  expect(report.gated.dependsOnHeld).toContain("Add the UI toggle");
  expect(calls.drain).toBe(0); // nothing build-ready → no half-built drain
  cleanup(q);
});

test("ATOMIC LANDING: a build-ready member missing from drain.succeeded (stranded) stages, does not land", async () => {
  const q = await emptyQueue();
  const { deps, calls } = stubDeps({
    designs: [fd({ surface: "tools", title: "Two-part" })],
    tasks: [[ci({ title: "P1", territory: ["tools/orchestrator/p1.ts"] }), ci({ title: "P2", territory: ["tools/orchestrator/p2.ts"] })]],
    reviews: [review({ taskVerdicts: [{ index: 0, buildReady: true }, { index: 1, buildReady: true }] })],
    // Drain returns only P1 succeeded; P2 neither succeeded nor blocked (stranded) — the
    // exact half-built scenario the old blocked===0 gate would have landed.
    drain: drainReport({ claimed: ["P1"], succeeded: ["P1"], blocked: [] }),
  });
  const report = await runFeatureDesign({ description: "two part", queuePath: q, repoRoot: ".", decisionsPath: "." }, deps);
  expect(calls.land).toBe(0); // NOT all build-ready members built → must not land
  expect(report.landed).toBe(false);
  expect(report.landResult).toContain("not built");
  cleanup(q);
});

test("review bounce: re-design returning null aborts — never builds the structurally-rejected design", async () => {
  const q = await emptyQueue();
  const { deps, calls } = stubDeps({
    designs: [fd({ surface: "organs", title: "rejected" }), null as never], // second runDesign fails
    tasks: [[ci({ title: "x", territory: ["organs/x.tsx"] })]],
    reviews: [review({ designVerdict: "revise", required: ["wrong"] })],
  });
  const report = await runFeatureDesign({ description: "x", queuePath: q, repoRoot: ".", decisionsPath: "." }, deps);
  expect(report.aborted).toContain("re-design");
  expect(calls.drain).toBe(0);
  expect((await readItems(q)).length).toBe(0); // nothing enqueued
  cleanup(q);
});

test("DUPLICATE TITLES (break-it #3): same-titled build-ready members are held @needs-intake — cannot land a half-built feature", async () => {
  const q = await emptyQueue();
  const { deps, calls } = stubDeps({
    designs: [fd({ surface: "tools", title: "Dup feature" })],
    // Two DIFFERENT tasks the decompose basha gave the SAME title (distinct territories).
    tasks: [[
      ci({ title: "Add helper", territory: ["tools/orchestrator/a.ts"] }),
      ci({ title: "Add helper", territory: ["tools/orchestrator/b.ts"] }),
    ]],
    reviews: [review({ taskVerdicts: [{ index: 0, buildReady: true }, { index: 1, buildReady: true }] })],
    // The old guard would have landed on this (one success satisfies both via Set membership).
    drain: drainReport({ claimed: ["Add helper"], succeeded: ["Add helper"], blocked: [] }),
  });
  const report = await runFeatureDesign({ description: "dup", queuePath: q, repoRoot: ".", decisionsPath: "." }, deps);
  const items = await readItems(q);
  expect(items.every((i) => i.status === "needs-intake")).toBe(true); // both duplicates held
  expect(report.gated.duplicateTitle).toContain("Add helper");
  expect(calls.drain).toBe(0); // nothing build-ready → no autonomous build
  expect(calls.land).toBe(0); // and certainly no land
  cleanup(q);
});

test("a design the review rejects TWICE forces every task @needs-intake (never auto-builds a contested design)", async () => {
  const q = await emptyQueue();
  const { deps, calls } = stubDeps({
    designs: [fd({ surface: "tools", title: "v1" }), fd({ surface: "tools", title: "v2" })],
    tasks: [[ci({ title: "T", territory: ["tools/orchestrator/t.ts"] })], [ci({ title: "T", territory: ["tools/orchestrator/t.ts"] })]],
    reviews: [review({ designVerdict: "revise", required: ["still wrong"] }), review({ designVerdict: "revise", required: ["still wrong"] })],
  });
  const report = await runFeatureDesign({ description: "x", queuePath: q, repoRoot: ".", decisionsPath: "." }, deps);
  expect((await readItems(q)).find((i) => i.title === "T")?.status).toBe("needs-intake");
  expect(report.gated.structuralRevise).toContain("T");
  expect(calls.drain).toBe(0);
  cleanup(q);
});

// ---------------------------------------------------------------------------
// Phase (b): the design-door alignment gate — ADVISORY only (spec 6, §5.2)
// ---------------------------------------------------------------------------

test("DRIFT-NEVER-BLOCKS: a design classifyDrift deems material yields alignment.material=true but report.aborted=false, NO task forced needs-intake, run proceeds", async () => {
  const q = await emptyQueue();
  // A confirmed brief whose CORE SCOPE the fake design violates: the design lands on "tools" but
  // "tools" is a forbidden surface (medium sensitivity default fires on this low-tier contradiction).
  const brief = confirmedBrief({ forbiddenSurfaces: ["tools"] });
  const { deps, calls } = stubDeps({
    loadBrief: okLoad(brief),
    designs: [fd({ surface: "tools", title: "Off-scope feature", affectsTerritory: ["tools/orchestrator/x.ts"] })],
    tasks: [[ci({ title: "Add helper", territory: ["tools/orchestrator/x.ts"] })]],
    reviews: [review({ taskVerdicts: [{ index: 0, buildReady: true }] })],
    drain: drainReport({ claimed: ["Add helper"], succeeded: ["Add helper"] }),
    landOk: true,
  });
  const report = await runFeatureDesign(
    { description: "off-scope", queuePath: q, repoRoot: ".", decisionsPath: ".", briefPath: "/fake/brief.ts" },
    deps,
  );

  // The advisory signal fired…
  expect(report.alignment?.material).toBe(true);
  // …but it NEVER aborts, NEVER forces needs-intake, NEVER breaks the loop: the run proceeds.
  expect(report.aborted).toBeUndefined();
  const items = await readItems(q);
  expect(items.find((i) => i.title === "Add helper")?.status).toBe("unclaimed"); // NOT needs-intake
  expect(calls.drain).toBe(1); // it built
  expect(report.landed).toBe(true);
  expect(calls.loadBrief).toBe(1); // loaded exactly once
  cleanup(q);
});

test("an in-scope confirmed design produces NO alignment signal (no nag) and the brief loads once", async () => {
  const q = await emptyQueue();
  // inScopeSurfaces includes "tools"; the design is on "tools" → no drift at default 'medium'.
  const brief = confirmedBrief({ inScopeSurfaces: ["tools"] });
  const { deps, calls } = stubDeps({
    loadBrief: okLoad(brief),
    designs: [fd({ surface: "tools", title: "In-scope feature", affectsTerritory: ["tools/orchestrator/x.ts"] })],
    tasks: [[ci({ title: "Add helper", territory: ["tools/orchestrator/x.ts"] })]],
    reviews: [review({ taskVerdicts: [{ index: 0, buildReady: true }] })],
    drain: drainReport({ claimed: ["Add helper"], succeeded: ["Add helper"] }),
  });
  const report = await runFeatureDesign(
    { description: "in-scope", queuePath: q, repoRoot: ".", decisionsPath: ".", briefPath: "/fake/brief.ts" },
    deps,
  );
  expect(report.alignment).toBeUndefined(); // no drift => no advisory signal
  expect(calls.loadBrief).toBe(1);
  // the pre-loaded brief threaded into BOTH stages (one load, never re-loaded per callsite)
  expect(calls.designBriefs[0]).toBe(brief);
  expect(calls.decomposeBriefs[0]).toBe(brief);
  cleanup(q);
});

test("ALIGNMENT-NEVER-RELAXES-PARK: a person-reaching design deemed 'aligned' by Tier 2 STILL parks via classifyIrreversible", async () => {
  const q = await emptyQueue();
  // A brief that would flag the surface as drift (forbidden), BUT a fake Tier-2 says material:false
  // ("aligned"). The person-reaching PARK rail must still fire — alignment never writes status.
  const brief = confirmedBrief({ forbiddenSurfaces: ["tools"] });
  const { deps, calls } = stubDeps({
    loadBrief: okLoad(brief),
    runAlignmentCheck: async () => ({ material: false, reason: "actually fine", offer: "build-anyway" }),
    designs: [fd({ surface: "tools", title: "Notifier", affectsTerritory: ["tools/jobs/notifier.ts"] })],
    // a person-reaching task the LLM review wrongly approves
    tasks: [[ci({ title: "Email each person a digest", goal: "send each person an email", territory: ["tools/jobs/notifier.ts"] })]],
    reviews: [review({ taskVerdicts: [{ index: 0, buildReady: true, reason: "looks fine" }] })],
  });
  const report = await runFeatureDesign(
    { description: "notifier", queuePath: q, repoRoot: ".", decisionsPath: ".", briefPath: "/fake/brief.ts", freezeAuthorized: true },
    deps,
  );
  const items = await readItems(q);
  // The PARK rail (classifyIrreversible) is UNCHANGED by the "aligned" Tier-2 verdict.
  expect(items.find((i) => i.title === "Email each person a digest")?.status).toBe("needs-intake");
  expect(report.gated.irreversible).toContain("Email each person a digest");
  expect(calls.drain).toBe(0); // nothing build-ready (the person-reaching task is parked)
  cleanup(q);
});

test("SINGLE-LOUD-SIGNAL: an unparseable brief notifies EXACTLY ONCE for the brief-unparseable reason and the design proceeds with NO brief", async () => {
  const q = await emptyQueue();
  const { deps, calls } = stubDeps({
    loadBrief: async () => ({ brief: null, status: "unparseable", errors: ["botched human edit"] }),
    designs: [fd({ surface: "tools", title: "Feature", affectsTerritory: ["tools/orchestrator/x.ts"] })],
    tasks: [[ci({ title: "Add helper", territory: ["tools/orchestrator/x.ts"] })]],
    reviews: [review({ taskVerdicts: [{ index: 0, buildReady: true }] })],
    drain: drainReport({ claimed: ["Add helper"], succeeded: ["Add helper"] }),
    landOk: true,
  });
  const report = await runFeatureDesign(
    { description: "x", queuePath: q, repoRoot: ".", decisionsPath: ".", briefPath: "/fake/brief.ts" },
    deps,
  );
  // EXACTLY ONE notify carries the brief-unparseable reason (single loud signal for the run).
  const unparseableNotifies = calls.notify.filter((n) => /brief unparseable/i.test(n));
  expect(unparseableNotifies.length).toBe(1);
  // The brief is loaded once and the run degrades to "no brief": no alignment signal, no brief
  // threaded into the stages, build still proceeds.
  expect(calls.loadBrief).toBe(1);
  expect(report.alignment).toBeUndefined();
  expect(calls.designBriefs[0]).toBeNull(); // degraded to no brief
  expect(report.landed).toBe(true);
  cleanup(q);
});

test("Tier 2 refines the advisory reason/offer when Tier 1 is material, but cannot DOWNGRADE the material verdict", async () => {
  const q = await emptyQueue();
  const brief = confirmedBrief({ forbiddenSurfaces: ["tools"] });
  const { deps, calls } = stubDeps({
    loadBrief: okLoad(brief),
    // Tier 2 returns material:false (a downgrade attempt) — runFeatureDesign keeps the Tier-1
    // material verdict and only ADOPTS the refined reason/offer (handled inside the alignment step).
    runAlignmentCheck: async () => ({ material: false, reason: "refined reason", offer: "reshape it" }),
    designs: [fd({ surface: "tools", title: "Off-scope", affectsTerritory: ["tools/orchestrator/x.ts"] })],
    tasks: [[ci({ title: "Add helper", territory: ["tools/orchestrator/x.ts"] })]],
    reviews: [review({ taskVerdicts: [{ index: 0, buildReady: true }] })],
    drain: drainReport({ claimed: ["Add helper"], succeeded: ["Add helper"] }),
  });
  const report = await runFeatureDesign(
    { description: "off-scope", queuePath: q, repoRoot: ".", decisionsPath: ".", briefPath: "/fake/brief.ts" },
    deps,
  );
  expect(calls.alignment).toBe(1); // Tier 2 fired (because Tier 1 was material)
  expect(report.alignment?.material).toBe(true); // NOT downgraded
  expect(report.alignment?.reason).toBe("refined reason"); // reason refined by Tier 2
  expect(report.alignment?.offer).toBe("reshape it"); // offer refined by Tier 2
  cleanup(q);
});

test("Tier 2 is NOT fired when Tier 1 finds no drift (model cost gated to material drift)", async () => {
  const q = await emptyQueue();
  const brief = confirmedBrief({ inScopeSurfaces: ["tools"] }); // in-scope design → no drift
  let alignmentFired = 0;
  const { deps } = stubDeps({
    loadBrief: okLoad(brief),
    runAlignmentCheck: async () => {
      alignmentFired++;
      return { material: true };
    },
    designs: [fd({ surface: "tools", title: "In-scope", affectsTerritory: ["tools/orchestrator/x.ts"] })],
    tasks: [[ci({ title: "Add helper", territory: ["tools/orchestrator/x.ts"] })]],
    reviews: [review({ taskVerdicts: [{ index: 0, buildReady: true }] })],
    drain: drainReport({ claimed: ["Add helper"], succeeded: ["Add helper"] }),
  });
  await runFeatureDesign(
    { description: "in-scope", queuePath: q, repoRoot: ".", decisionsPath: ".", briefPath: "/fake/brief.ts" },
    deps,
  );
  expect(alignmentFired).toBe(0); // Tier 2 gated behind a material Tier-1 verdict
  cleanup(q);
});
