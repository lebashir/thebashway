import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIntakePrompt, buildIntakePromptFromDisk } from "../../intake-prompt";
import { DesignBriefSchema, type DesignBrief } from "../../brief";
import type { LoadBriefResult } from "../../load-brief";
import type { Lesson } from "../../lessons";

const store: Lesson[] = [
  { tag: "decision", rule: "prefer the lean option" },        // global
  { tag: "tools", rule: "tools surface has no prod deploy" }, // area-scoped
  { tag: "organs", rule: "organs UI is FROZEN" },             // other area
];

function briefFixture(overrides: Partial<Record<string, unknown>> = {}): DesignBrief {
  return DesignBriefSchema.parse({
    confirmed: true,
    narrative: "long prose",
    purpose: "Ship the north star.",
    whyNow: "now",
    whoServed: "the owner",
    scope: "the brief schema + wiring",
    limits: "no enterprise governance",
    inScopeSurfaces: ["app"],
    forbiddenSurfaces: [],
    forbiddenTerritory: [],
    conventions: ["Tests run via `bun test`."],
    glossary: [{ term: "brief", means: "the per-project north star" }],
    gaps: [],
    successCriteria: [
      { id: "tests", statement: "tests pass", check: { kind: "command", run: "bun test" }, required: true },
    ],
    milestones: [],
    ...overrides,
  });
}

test("global [decision] rules always inject; matching area injects; other areas do not", () => {
  const out = buildIntakePrompt({ decisionLessons: store, itemAreas: ["tools"], taskBody: "INTAKE: foo" });
  expect(out).toContain("prefer the lean option"); // global, always
  expect(out).toContain("tools surface has no prod deploy"); // area match
  expect(out).not.toContain("organs UI is FROZEN"); // non-matching area dropped
  expect(out).toContain("INTAKE: foo");
});

test("with no area, only global decision rules inject", () => {
  const out = buildIntakePrompt({ decisionLessons: store, itemAreas: [], taskBody: "x" });
  expect(out).toContain("prefer the lean option");
  expect(out).not.toContain("tools surface has no prod deploy");
});

// ---------------------------------------------------------------------------
// North-star brief feed (the STABLE layer above the LEARNED decision defaults)
// ---------------------------------------------------------------------------

test("passing a brief prepends the 'North star — build toward this:' block ABOVE the decision-defaults", () => {
  const out = buildIntakePrompt({
    decisionLessons: store,
    itemAreas: ["tools"],
    taskBody: "INTAKE: foo",
    brief: briefFixture(),
  });
  expect(out).toContain("North star — build toward this:");
  expect(out).toContain("Ship the north star."); // the brief's purpose is rendered
  // the brief block comes BEFORE the decision-defaults block
  expect(out.indexOf("North star — build toward this:")).toBeLessThan(out.indexOf("Decision defaults"));
});

test("OMITTING the brief leaves the output BYTE-IDENTICAL to today (additive option)", () => {
  const without = buildIntakePrompt({ decisionLessons: store, itemAreas: ["tools"], taskBody: "INTAKE: foo" });
  const withNull = buildIntakePrompt({ decisionLessons: store, itemAreas: ["tools"], taskBody: "INTAKE: foo", brief: null });
  const withUndef = buildIntakePrompt({ decisionLessons: store, itemAreas: ["tools"], taskBody: "INTAKE: foo", brief: undefined });
  expect(withNull).toBe(without);
  expect(withUndef).toBe(without);
  expect(without).not.toContain("North star");
});

test("an UNCONFIRMED / thin brief injects but its gap/unconfirmed fields render marked UNCONFIRMED", () => {
  const thin = briefFixture({ confirmed: false, gaps: ["who is served", "deploy/land norm"] });
  const out = buildIntakePrompt({ decisionLessons: store, itemAreas: ["tools"], taskBody: "x", brief: thin });
  expect(out).toContain("North star — build toward this:");
  expect(out).toContain("UNCONFIRMED"); // a guessed scope is not presented as authoritative
  expect(out).toContain("who is served"); // the gaps surface
});

test("the LEARNED-layer owner name is genericized (no hard-coded 'Bashir')", () => {
  const out = buildIntakePrompt({ decisionLessons: store, itemAreas: ["tools"], taskBody: "x" });
  expect(out).not.toContain("Bashir");
  expect(out).toContain("apply before asking the owner:");
});

// ---------------------------------------------------------------------------
// buildIntakePromptFromDisk: the *FromDisk* function actually LOADS the brief from
// briefPath (spec 5.2 wires callsites to pass briefPath, NOT a pre-loaded brief).
// ---------------------------------------------------------------------------

const VALID_BRIEF_MODULE = `export default {
  confirmed: true,
  narrative: "long prose",
  purpose: "Ship the north star.",
  whyNow: "now",
  whoServed: "the owner",
  scope: "the brief schema + wiring",
  limits: "no enterprise governance",
  inScopeSurfaces: ["app"],
  successCriteria: [
    { id: "tests", statement: "tests pass", check: { kind: "command", run: "bun test" }, required: true },
  ],
};
`;

test("buildIntakePromptFromDisk loads the brief from briefPath and renders the North-star block", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tbw-intake-disk-"));
  const briefPath = join(dir, "brief.ts");
  writeFileSync(briefPath, VALID_BRIEF_MODULE, "utf8");

  // ONLY briefPath is passed (no pre-loaded `brief`) — exactly how design-run/audit-run wire it.
  const out = await buildIntakePromptFromDisk({
    decisionsPath: join(dir, "decisions.md"), // absent => no decision defaults
    itemAreas: ["tools"],
    taskBody: "INTAKE: foo",
    briefPath,
  });
  expect(out).toContain("North star — build toward this:");
  expect(out).toContain("Ship the north star."); // proves the brief loaded from disk, not dropped
  expect(out).toContain("INTAKE: foo");
});

test("buildIntakePromptFromDisk with an UNPARSEABLE brief surfaces status (loud signal) and does NOT inject", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tbw-intake-broken-"));
  const briefPath = join(dir, "brief.ts");
  // export default of a brief MISSING the required `command` criterion => safeParse fails.
  writeFileSync(
    briefPath,
    `export default { purpose: "x", whyNow: "x", whoServed: "x", scope: "x", limits: "x", successCriteria: [] };\n`,
    "utf8",
  );

  let seen: LoadBriefResult | null = null;
  const out = await buildIntakePromptFromDisk({
    decisionsPath: join(dir, "decisions.md"),
    itemAreas: ["tools"],
    taskBody: "INTAKE: foo",
    briefPath,
    onBriefStatus: (r) => {
      seen = r;
    },
  });
  // the §3.1 contract: caller is told it is unparseable (so it can emit the loud signal)…
  expect(seen).not.toBeNull();
  expect(seen!.status).toBe("unparseable");
  // …and the broken brief is NOT silently injected as the north star.
  expect(out).not.toContain("North star — build toward this:");
  expect(out).toContain("INTAKE: foo");
});

test("buildIntakePromptFromDisk with an ABSENT brief injects nothing and does not surface a loud signal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tbw-intake-absent-"));
  let seen: LoadBriefResult | null = null;
  const out = await buildIntakePromptFromDisk({
    decisionsPath: join(dir, "decisions.md"),
    itemAreas: ["tools"],
    taskBody: "INTAKE: foo",
    briefPath: join(dir, "brief.ts"), // does not exist
    onBriefStatus: (r) => {
      seen = r;
    },
  });
  expect(seen!.status).toBe("absent"); // benign — the only "no brief" state
  expect(out).not.toContain("North star");
});

test("buildIntakePromptFromDisk: a pre-loaded `brief` takes precedence and briefPath is not loaded", async () => {
  const pre = briefFixture({ purpose: "Pre-loaded purpose." });
  let called = false;
  const out = await buildIntakePromptFromDisk({
    decisionsPath: "/nonexistent/decisions.md",
    itemAreas: ["tools"],
    taskBody: "x",
    brief: pre,
    briefPath: "/nonexistent/brief.ts", // would be 'absent' if loaded — but brief wins, so unused
    onBriefStatus: () => {
      called = true;
    },
  });
  expect(out).toContain("Pre-loaded purpose.");
  expect(called).toBe(false); // pre-loaded brief => briefPath path is not taken
});

// Phase (b): runFeatureDesign loads the brief ONCE and threads it PRE-LOADED into the design,
// decompose, and shape callsites (so they never re-load / re-emit a park). This is the exact
// path those callsites use — a pre-loaded brief renders the North-star block, no disk load.
test("a pre-loaded brief renders the North-star block via the FromDisk path the 3 design/audit callsites use", async () => {
  const pre = briefFixture({ purpose: "The threaded north star." });
  let loadAttempted = false;
  const out = await buildIntakePromptFromDisk({
    decisionsPath: "/nonexistent/decisions.md",
    itemAreas: ["tools"],
    taskBody: "INTAKE: shape this",
    brief: pre, // the callsites pass the pre-loaded brief (NOT briefPath) so the load happens once
    onBriefStatus: () => {
      loadAttempted = true;
    },
  });
  expect(out).toContain("North star — build toward this:");
  expect(out).toContain("The threaded north star."); // the threaded brief's purpose renders
  expect(out).toContain("INTAKE: shape this");
  expect(loadAttempted).toBe(false); // pre-loaded => no second disk load / no second loud signal
});
