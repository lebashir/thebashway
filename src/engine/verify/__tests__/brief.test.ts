import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CheckSpecSchema,
  SuccessCriterionSchema,
  GlossaryEntrySchema,
  DesignBriefSchema,
  renderBriefForPrompt,
  classifyDrift,
  gapsOf,
  type DesignBrief,
} from "../../brief";
import { loadBrief } from "../../load-brief";

// ---------------------------------------------------------------------------
// A full, valid, terminable brief fixture (one required `command` criterion).
// ---------------------------------------------------------------------------
function fullBriefInput(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    confirmed: true,
    narrative: "The long-form prose of what this project is.",
    purpose: "Ship the north-star design brief.",
    whyNow: "The engine has no purpose layer.",
    whoServed: "One owner's personal projects.",
    scope: "Per-project design brief: schema + loader.",
    limits: "No enterprise governance, no multi-stakeholder sign-off.",
    inScopeSurfaces: ["organs"],
    forbiddenSurfaces: ["marketing"],
    forbiddenTerritory: ["src/legacy/**"],
    timeHorizon: "this epic",
    target: "all required criteria",
    openExplorations: [],
    conventions: ["Tests run via `bun test`."],
    glossary: [{ term: "brief", means: "the per-project north star" }],
    gaps: [],
    successCriteria: [
      { id: "tests", statement: "all tests pass", check: { kind: "command", run: "bun test" }, required: true },
      { id: "verify", statement: "verify chain passes", check: { kind: "verify" }, required: false },
    ],
    milestones: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DesignBriefSchema — parsing + the command-requiring .refine()
// ---------------------------------------------------------------------------
test("DesignBriefSchema parses a full brief", () => {
  const parsed = DesignBriefSchema.safeParse(fullBriefInput());
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.purpose).toBe("Ship the north-star design brief.");
    expect(parsed.data.successCriteria.length).toBe(2);
    // CheckSpec defaults applied:
    const cmd = parsed.data.successCriteria[0]!.check; // index 0 of 2-element array asserted above
    expect(cmd.kind).toBe("command");
    if (cmd.kind === "command") {
      expect(cmd.expectExit).toBe(0);
      expect(cmd.timeoutMs).toBe(60_000);
    }
  }
});

test(".refine() REJECTS a brief whose only required criterion is {kind:'verify'}", () => {
  const parsed = DesignBriefSchema.safeParse(
    fullBriefInput({
      successCriteria: [
        { id: "verify", statement: "verify chain passes", check: { kind: "verify" }, required: true },
      ],
    }),
  );
  expect(parsed.success).toBe(false);
  if (!parsed.success) {
    expect(parsed.error.issues.some((i) => /command/i.test(i.message))).toBe(true);
  }
});

test(".refine() REJECTS a brief whose only required criterion is {kind:'file-exists'}", () => {
  const parsed = DesignBriefSchema.safeParse(
    fullBriefInput({
      successCriteria: [
        { id: "doc", statement: "doc exists", check: { kind: "file-exists", path: "README.md" }, required: true },
      ],
    }),
  );
  expect(parsed.success).toBe(false);
});

test(".refine() REJECTS when the only command criterion is required:false", () => {
  // a command criterion that is NOT required does not satisfy terminability
  const parsed = DesignBriefSchema.safeParse(
    fullBriefInput({
      successCriteria: [
        { id: "cmd", statement: "command", check: { kind: "command", run: "bun test" }, required: false },
        { id: "verify", statement: "verify", check: { kind: "verify" }, required: true },
      ],
    }),
  );
  expect(parsed.success).toBe(false);
});

test(".refine() ACCEPTS a brief with a required {kind:'command'} criterion", () => {
  const parsed = DesignBriefSchema.safeParse(
    fullBriefInput({
      successCriteria: [
        { id: "cmd", statement: "command", check: { kind: "command", run: "bun test" }, required: true },
      ],
    }),
  );
  expect(parsed.success).toBe(true);
});

// ---------------------------------------------------------------------------
// CheckSpec — rejects unknown kind + free-text checks
// ---------------------------------------------------------------------------
test("CheckSpec rejects an unknown kind", () => {
  expect(CheckSpecSchema.safeParse({ kind: "screenshot", url: "x" }).success).toBe(false);
});

test("CheckSpec rejects a free-text (no kind) check", () => {
  expect(CheckSpecSchema.safeParse("the UX feels fast").success).toBe(false);
  expect(CheckSpecSchema.safeParse({ statement: "the UX feels fast" }).success).toBe(false);
});

test("CheckSpec command requires a non-empty run", () => {
  expect(CheckSpecSchema.safeParse({ kind: "command", run: "" }).success).toBe(false);
  expect(CheckSpecSchema.safeParse({ kind: "command", run: "x" }).success).toBe(true);
});

test("CheckSpec command rejects a non-positive timeoutMs", () => {
  expect(CheckSpecSchema.safeParse({ kind: "command", run: "x", timeoutMs: 0 }).success).toBe(false);
  expect(CheckSpecSchema.safeParse({ kind: "command", run: "x", timeoutMs: -5 }).success).toBe(false);
});

test("SuccessCriterion defaults required to true", () => {
  const parsed = SuccessCriterionSchema.safeParse({
    id: "x",
    statement: "y",
    check: { kind: "verify" },
  });
  expect(parsed.success).toBe(true);
  if (parsed.success) expect(parsed.data.required).toBe(true);
});

// ---------------------------------------------------------------------------
// conventions / glossary — typed arrays with .default([]), never affect terminability
// ---------------------------------------------------------------------------
test("a brief with NEITHER conventions nor glossary still parses (defaults to [])", () => {
  const input = fullBriefInput();
  delete input.conventions;
  delete input.glossary;
  const parsed = DesignBriefSchema.safeParse(input);
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.conventions).toEqual([]);
    expect(parsed.data.glossary).toEqual([]);
  }
});

test("GlossaryEntry REQUIRES both term and means", () => {
  expect(GlossaryEntrySchema.safeParse({ term: "x", means: "y" }).success).toBe(true);
  expect(GlossaryEntrySchema.safeParse({ term: "x" }).success).toBe(false);
  expect(GlossaryEntrySchema.safeParse({ means: "y" }).success).toBe(false);
  expect(GlossaryEntrySchema.safeParse({ term: "", means: "y" }).success).toBe(false);
});

test("a 50-bullet conventions brief loads exactly like conventions:[] (terminability unaffected)", () => {
  const fifty = Array.from({ length: 50 }, (_, i) => `convention ${i}`);
  const withConv = DesignBriefSchema.safeParse(fullBriefInput({ conventions: fifty }));
  const withoutConv = DesignBriefSchema.safeParse(fullBriefInput({ conventions: [] }));
  expect(withConv.success).toBe(true);
  expect(withoutConv.success).toBe(true);
  // both load; the .refine() (terminability) is satisfied identically by the command criterion
  if (withConv.success) expect(withConv.data.conventions.length).toBe(50);
});

// ---------------------------------------------------------------------------
// renderBriefForPrompt — BOUNDED + DRAFT/UNCONFIRMED marking
// ---------------------------------------------------------------------------
test("renderBriefForPrompt is BOUNDED for a 100-entry conventions + 100-entry glossary", () => {
  const big = (n: number) => DesignBriefSchema.parse(
    fullBriefInput({
      conventions: Array.from({ length: n }, (_, i) => `convention bullet number ${i}`),
      glossary: Array.from({ length: n }, (_, i) => ({ term: `term${i}`, means: `meaning of term ${i}` })),
    }),
  );
  const small = renderBriefForPrompt(big(5));
  const huge = renderBriefForPrompt(big(100));

  // rendered length does NOT scale with array size: the 100-entry render is not meaningfully
  // larger than the small one (it is capped at top-N/top-M + a "+K more" note).
  expect(huge.length).toBeLessThan(small.length * 2);

  // the cap-overflow note appears for both conventions and glossary
  expect(huge).toContain("more)");
  // the whole array is NOT dumped: the 99th convention is beyond the cap
  expect(huge).not.toContain("convention bullet number 99");
  expect(huge).not.toContain("term99");
});

test("renderBriefForPrompt marks DRAFT/UNCONFIRMED when confirmed:false", () => {
  const draft = DesignBriefSchema.parse(
    fullBriefInput({ confirmed: false, gaps: ["naming conventions", "deploy/land norm"] }),
  );
  const rendered = renderBriefForPrompt(draft);
  expect(rendered).toContain("UNCONFIRMED");
  // the gaps surface in the unconfirmed render
  expect(rendered).toContain("naming conventions");
});

test("renderBriefForPrompt does NOT add the UNCONFIRMED note for a confirmed brief", () => {
  const confirmed = DesignBriefSchema.parse(fullBriefInput({ confirmed: true }));
  const rendered = renderBriefForPrompt(confirmed);
  expect(rendered).not.toContain("UNCONFIRMED");
  // it still renders the real purpose and the success checklist
  expect(rendered).toContain("Ship the north-star design brief.");
  expect(rendered).toContain("Success checklist:");
});

// ---------------------------------------------------------------------------
// loadBrief — existing-but-broken => 'unparseable' (not silent null); missing => 'absent'
// ---------------------------------------------------------------------------
test("loadBrief of a MISSING path returns status:'absent' (benign)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tbw-brief-"));
  const res = await loadBrief(join(dir, "does-not-exist.ts"));
  expect(res.status).toBe("absent");
  expect(res.brief).toBeNull();
  expect(res.errors).toEqual([]);
});

test("loadBrief of an existing-but-BROKEN (invalid schema) module returns 'unparseable', not silent null", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tbw-brief-"));
  const p = join(dir, "brief.ts");
  // a module that parses as JS but FAILS the schema (no successCriteria)
  writeFileSync(p, `export default { purpose: "x" };`);
  const res = await loadBrief(p);
  expect(res.status).toBe("unparseable");
  expect(res.brief).toBeNull();
  expect(res.errors.length).toBeGreaterThan(0);
});

test("loadBrief of a module whose import THROWS returns 'unparseable'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tbw-brief-"));
  const p = join(dir, "brief.ts");
  writeFileSync(p, `throw new Error("botched human edit");\nexport default {};`);
  const res = await loadBrief(p);
  expect(res.status).toBe("unparseable");
  expect(res.brief).toBeNull();
  expect(res.errors.length).toBeGreaterThan(0);
});

test("loadBrief of a VALID module returns status:'ok' with the parsed brief", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tbw-brief-"));
  const p = join(dir, "brief.ts");
  writeFileSync(
    p,
    `export default ${JSON.stringify(fullBriefInput())};`,
  );
  const res = await loadBrief(p);
  expect(res.status).toBe("ok");
  expect(res.brief).not.toBeNull();
  expect(res.brief?.purpose).toBe("Ship the north-star design brief.");
  expect(res.errors).toEqual([]);
});

test("loadBrief of a module that FAILS the command-criterion .refine() is 'unparseable'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tbw-brief-"));
  const p = join(dir, "brief.ts");
  // only a required verify criterion — the .refine() rejects it (must not silently load)
  const bad = fullBriefInput({
    successCriteria: [{ id: "v", statement: "verify", check: { kind: "verify" }, required: true }],
  });
  writeFileSync(p, `export default ${JSON.stringify(bad)};`);
  const res = await loadBrief(p);
  expect(res.status).toBe("unparseable");
  expect(res.brief).toBeNull();
});

// ---------------------------------------------------------------------------
// classifyDrift — deterministic over structured fields
// ---------------------------------------------------------------------------
function brief(overrides: Partial<Record<string, unknown>> = {}): DesignBrief {
  return DesignBriefSchema.parse(fullBriefInput(overrides));
}

test("classifyDrift returns {material:false} when confirmed:false REGARDLESS of sensitivity", () => {
  const draft = brief({
    confirmed: false,
    forbiddenSurfaces: ["marketing"],
    inScopeSurfaces: ["organs"],
    forbiddenTerritory: ["src/legacy/**"],
  });
  for (const s of ["off", "low", "medium", "high"] as const) {
    // a design that WOULD fire (forbidden surface) is suppressed because the brief is unconfirmed
    expect(classifyDrift({ surface: "marketing" }, draft, s)).toEqual({ material: false });
  }
});

test("classifyDrift 'off' is always {material:false} (kill switch)", () => {
  const b = brief({ forbiddenSurfaces: ["marketing"], inScopeSurfaces: ["organs"] });
  expect(classifyDrift({ surface: "marketing" }, b, "off")).toEqual({ material: false });
});

test("classifyDrift 'low' fires on a forbidden surface and ONLY on a real contradiction", () => {
  const b = brief({ forbiddenSurfaces: ["marketing"], inScopeSurfaces: ["organs"] });
  // forbidden surface -> fires
  expect(classifyDrift({ surface: "marketing" }, b, "low").material).toBe(true);
  // an in-scope design -> does NOT fire at 'low' (no nagging on out-of-inScope at low)
  expect(classifyDrift({ surface: "side-surface" }, b, "low").material).toBe(false);
});

test("classifyDrift 'low' fires on forbiddenTerritory intersection", () => {
  const b = brief({ forbiddenTerritory: ["src/legacy/**"], inScopeSurfaces: [] });
  expect(classifyDrift({ surface: "organs", affectsTerritory: ["src/legacy/foo.ts"] }, b, "low").material).toBe(true);
  // untouched territory -> no fire
  expect(classifyDrift({ surface: "organs", affectsTerritory: ["src/engine/x.ts"] }, b, "low").material).toBe(false);
});

test("classifyDrift 'medium' ALSO fires when inScopeSurfaces non-empty AND surface not in it", () => {
  const b = brief({ inScopeSurfaces: ["organs"], forbiddenSurfaces: [], forbiddenTerritory: [] });
  // out of inScope -> fires at medium
  expect(classifyDrift({ surface: "side-surface" }, b, "medium").material).toBe(true);
  // in inScope -> does not fire
  expect(classifyDrift({ surface: "organs" }, b, "medium").material).toBe(false);
  // but at 'low' the same out-of-inScope design does NOT fire (medium-only rule)
  expect(classifyDrift({ surface: "side-surface" }, b, "low").material).toBe(false);
});

test("classifyDrift 'medium' does not fire when inScopeSurfaces is empty", () => {
  const b = brief({ inScopeSurfaces: [], forbiddenSurfaces: [], forbiddenTerritory: [] });
  expect(classifyDrift({ surface: "anything" }, b, "medium").material).toBe(false);
});

test("classifyDrift 'high' ALSO fires on a partial territory overlap with a forbidden glob", () => {
  const b = brief({ forbiddenTerritory: ["src/legacy/**"], inScopeSurfaces: [], forbiddenSurfaces: [] });
  // 'src/legacy-tool' shares the 'src' segment but is NOT a strict prefix of 'src/legacy' —
  // a partial overlap the strict 'low' territory test misses.
  const design = { surface: "organs", affectsTerritory: ["src/legacy-tool/x.ts"] };
  expect(classifyDrift(design, b, "high").material).toBe(true);
  // at 'low'/'medium' the same partial overlap does NOT fire
  expect(classifyDrift(design, b, "low").material).toBe(false);
  expect(classifyDrift(design, b, "medium").material).toBe(false);
});

test("classifyDrift 'high' does not fire on fully-disjoint territory", () => {
  const b = brief({ forbiddenTerritory: ["src/legacy/**"], inScopeSurfaces: [], forbiddenSurfaces: [] });
  // 'docs/**' shares NO leading segment with 'src/legacy/**'
  expect(classifyDrift({ surface: "organs", affectsTerritory: ["docs/x.md"] }, b, "high").material).toBe(false);
});

// ---------------------------------------------------------------------------
// gapsOf — the single-source-of-truth readiness reader (pure)
// ---------------------------------------------------------------------------
// helper: a minimal valid brief (the schema requires >=1 required command criterion)
function gapsBrief(over: Record<string, unknown> = {}) {
  return DesignBriefSchema.parse({
    purpose: "p", whyNow: "", whoServed: "w", scope: "s", limits: "l",
    successCriteria: [{ id: "c", statement: "s", check: { kind: "command", run: "bun test" }, required: true }],
    ...over,
  });
}

test("gapsOf: a filled confirmed brief is complete + autonomous-ready", () => {
  const r = gapsOf(gapsBrief({ confirmed: true }));
  expect(r.gaps).toEqual([]);
  expect(r.coreComplete).toBe(true);
  expect(r.autonomousReady).toBe(true);
  expect(r.confirmed).toBe(true);
});

test("gapsOf: empty Ring-1 core fields become gaps; whyNow does NOT", () => {
  const r = gapsOf(gapsBrief({ purpose: "", scope: "", whyNow: "" }));
  expect(r.coreComplete).toBe(false);
  expect(r.gaps).toContain("purpose");
  expect(r.gaps).toContain("scope");
  expect(r.gaps).not.toContain("why now");
});

test("gapsOf: the REPLACE-ME command placeholder => not autonomous-ready (a gap), still core-complete", () => {
  const r = gapsOf(gapsBrief({ successCriteria: [
    { id: "c", statement: "s", check: { kind: "command", run: "echo REPLACE-ME && exit 1" }, required: true },
  ] }));
  expect(r.coreComplete).toBe(true);
  expect(r.autonomousReady).toBe(false);
  expect(r.gaps).toContain("success check");
});
