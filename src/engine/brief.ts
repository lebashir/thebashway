// src/engine/brief.ts
// The per-project DESIGN BRIEF (north star): the pure data contract + the pure helpers
// the rest of the engine reads it through. PURE — no fs, no spawn, and NO write export
// (INV-A): the only writers of brief.ts live in the cold-start layer (seedBriefIfAbsent in
// init.ts, writeConfirmedBrief in the brief command path). Design/audit/drain/digest cannot
// import a brief writer because none is exported here. See
// docs/specs/2026-06-07-north-star-design-brief.md (sections 1.1, 3.1, 3.2, 6).
//
// The brief is loaded as a TS module that `export default`s a zod-validated object via
// dynamic import() (INV-B) — see load-brief.ts for the thin IO wrapper. There is no YAML and
// no hand-rolled markdown parser.
import { z } from "zod";
import { territoriesOverlap, globPrefix } from "./territory";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** A machine-checkable success-criterion check. A criterion that cannot be expressed as one
 * of these kinds cannot enter successCriteria — that is a schema invariant, not a prompt. */
export const CheckSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command"),
    run: z.string().min(1),
    expectExit: z.number().default(0),
    timeoutMs: z.number().int().positive().default(60_000),
  }),
  // the project's existing verify chain passes (surface chain) — cannot ALONE terminate
  z.object({ kind: z.literal("verify") }),
  z.object({ kind: z.literal("file-exists"), path: z.string().min(1) }),
]);
export type CheckSpec = z.infer<typeof CheckSpecSchema>;

export const SuccessCriterionSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  check: CheckSpecSchema,
  required: z.boolean().default(true),
});
export type SuccessCriterion = z.infer<typeof SuccessCriterionSchema>;

// A domain term -> plain meaning. Keeps a NON-TECHNICAL reader oriented and makes the engine
// speak the project's own vocabulary in design/intake prompts.
export const GlossaryEntrySchema = z.object({
  term: z.string().min(1),
  means: z.string().min(1),
});
export type GlossaryEntry = z.infer<typeof GlossaryEntrySchema>;

export const DesignBriefSchema = z
  .object({
    confirmed: z.boolean().default(false), // INV: load-bearing — see spec 4.2
    narrative: z.string().default(""), // the human-readable prose (long form)
    purpose: z.string(),
    whyNow: z.string(),
    whoServed: z.string(),
    scope: z.string(),
    limits: z.string(),
    // structured drift signals — what classifyDrift tests against (no prose matching):
    inScopeSurfaces: z.array(z.string()).default([]),
    forbiddenSurfaces: z.array(z.string()).default([]),
    forbiddenTerritory: z.array(z.string()).default([]), // globs the brief rules out
    timeHorizon: z.string().default(""),
    target: z.string().default(""),
    openExplorations: z.array(z.string()).default([]),
    // lean, inferred-first, grown-via-PROPOSAL — never engine-auto-written (INV-A):
    conventions: z.array(z.string()).default([]), // how-we-do-things bullets
    glossary: z.array(GlossaryEntrySchema).default([]), // domain term -> plain meaning
    gaps: z.array(z.string()).default([]), // un-inferred sections the interview must fill
    successCriteria: z.array(SuccessCriterionSchema).min(1),
    milestones: z
      .array(z.object({ statement: z.string().min(1), humanJudged: z.literal(true) }))
      .default([]),
  })
  .refine(
    // hold-firm #4: at least one REQUIRED, machine-checkable, NON-verify/non-file-exists
    // criterion. The seeded {kind:'verify'} criterion cannot alone make a brief terminable.
    (b) => b.successCriteria.some((c) => c.required && c.check.kind === "command"),
    {
      message:
        "brief must declare >=1 required 'command' success criterion (a purpose-bearing check; 'verify'/'file-exists' alone cannot terminate the loop — hold-firm #4)",
    },
  );
export type DesignBrief = z.infer<typeof DesignBriefSchema>;

// ---------------------------------------------------------------------------
// Pure helpers (mirror surfaceRoles() in design.ts — no fs, no spawn)
// ---------------------------------------------------------------------------

// Render caps for the TWO grown-over-time arrays (spec 3.2 rule 4): conventions and glossary are
// the fields that accrete over a project's life, so their prompt cost must stay bounded regardless
// of stored-array size. The prose brief.ts may hold more; the PROMPT never carries the whole array.
// (The other fields — successCriteria, scope-tag arrays, gaps — are not grown by the milestone
// path and are rendered in full; the spec's bounded guarantee is scoped to conventions+glossary.)
const CONVENTIONS_CAP = 10;
const GLOSSARY_CAP = 15;

/** A field that the draft has not settled yet — rendered marked UNCONFIRMED. */
function draftMark(brief: DesignBrief, value: string): string {
  return brief.confirmed ? value : `${value || "(none yet)"} [DRAFT/UNCONFIRMED]`;
}

/**
 * Compact render of the brief for an LLM prompt: purpose + scope/limits + TOP-N conventions +
 * TOP-M glossary (each with a "+K more" note when the stored array exceeds the cap) + the success
 * checklist. When confirmed===false, every gap/unconfirmed field is marked DRAFT/UNCONFIRMED so a
 * guessed scope is never presented as settled fact.
 *
 * Bounded guarantee (spec 3.2 rule 4): the two GROWN-OVER-TIME arrays — conventions and glossary —
 * are capped, so a 100-entry conventions/glossary array renders bounded (the property tested). The
 * other fields (successCriteria, scope-tag arrays, gaps) are rendered in full; they are not grown
 * by the milestone propose path, so the bounded guarantee is deliberately scoped to the two arrays
 * that accrete.
 */
export function renderBriefForPrompt(brief: DesignBrief): string {
  const lines: string[] = [];
  lines.push(`Purpose: ${draftMark(brief, brief.purpose)}`);
  lines.push(`Who it serves: ${draftMark(brief, brief.whoServed)}`);
  lines.push(`Scope: ${draftMark(brief, brief.scope)}`);
  lines.push(`Limits: ${draftMark(brief, brief.limits)}`);

  if (brief.inScopeSurfaces.length || brief.forbiddenSurfaces.length || brief.forbiddenTerritory.length) {
    lines.push(
      `In-scope surfaces: ${brief.inScopeSurfaces.join(", ") || "(unset)"}` +
        ` | Forbidden surfaces: ${brief.forbiddenSurfaces.join(", ") || "(none)"}` +
        ` | Forbidden territory: ${brief.forbiddenTerritory.join(", ") || "(none)"}`,
    );
  }

  const conv = brief.conventions.slice(0, CONVENTIONS_CAP);
  if (conv.length) {
    lines.push("Conventions:");
    for (const c of conv) lines.push(`  - ${c}`);
    const extra = brief.conventions.length - conv.length;
    if (extra > 0) lines.push(`  - (+${extra} more)`);
  }

  const gloss = brief.glossary.slice(0, GLOSSARY_CAP);
  if (gloss.length) {
    lines.push("Glossary:");
    for (const g of gloss) lines.push(`  - ${g.term}: ${g.means}`);
    const extra = brief.glossary.length - gloss.length;
    if (extra > 0) lines.push(`  - (+${extra} more)`);
  }

  if (brief.gaps.length && !brief.confirmed) {
    lines.push(`Gaps (DRAFT/UNCONFIRMED — interview must fill): ${brief.gaps.join("; ")}`);
  }

  lines.push("Success checklist:");
  for (const c of brief.successCriteria) {
    const req = c.required ? "[required]" : "[optional]";
    lines.push(`  - ${req} ${c.statement} (${c.check.kind})`);
  }

  if (!brief.confirmed) {
    lines.unshift("NOTE: this brief is an UNCONFIRMED draft — treat its fields as provisional.");
  }
  return lines.join("\n");
}

/**
 * Deterministic core-scope drift classifier over STRUCTURED fields only (no prose matching).
 *
 * - 'off' OR brief.confirmed===false => {material:false}  (kill switch / unconfirmed gate)
 * - 'low'    fires on design.surface ∈ forbiddenSurfaces OR affectsTerritory ∩ forbiddenTerritory
 * - 'medium' (default) ALSO fires when inScopeSurfaces is non-empty AND surface ∉ inScopeSurfaces
 * - 'high'   ALSO fires on a partial territory overlap with a forbidden glob
 */
export function classifyDrift(
  design: { surface?: string; affectsTerritory?: string[]; summary?: string },
  brief: DesignBrief,
  sensitivity: "off" | "low" | "medium" | "high",
): { material: boolean; reason?: string } {
  // unconfirmed brief is forced to 'off' (spec 4.2b): never warn against a vision no human
  // ratified.
  if (sensitivity === "off" || !brief.confirmed) return { material: false };

  const surface = design.surface ?? "";
  const affects = design.affectsTerritory ?? [];

  // --- 'low' tier (also fires at medium/high): outright forbidden contradiction ---
  if (surface && brief.forbiddenSurfaces.includes(surface)) {
    return { material: true, reason: `surface '${surface}' is in forbiddenSurfaces` };
  }
  if (affects.length && brief.forbiddenTerritory.length && territoriesOverlap(affects, brief.forbiddenTerritory)) {
    return { material: true, reason: `affectsTerritory intersects forbiddenTerritory` };
  }

  // --- 'medium' tier (also fires at high): designed outside the declared core scope ---
  if (sensitivity === "medium" || sensitivity === "high") {
    if (brief.inScopeSurfaces.length && surface && !brief.inScopeSurfaces.includes(surface)) {
      return { material: true, reason: `surface '${surface}' is not in inScopeSurfaces` };
    }
  }

  // --- 'high' tier: a minor stretch — partial overlap with a forbidden glob the conservative
  // prefix test missed (e.g. a forbidden 'src/legacy/**' vs an affected 'src/legacy-tool' that
  // shares the glob's static prefix segment-loosely but not the strict path-prefix). ---
  if (sensitivity === "high") {
    if (affects.length && brief.forbiddenTerritory.length && partialTerritoryOverlap(affects, brief.forbiddenTerritory)) {
      return { material: true, reason: `affectsTerritory partially overlaps a forbidden glob` };
    }
  }

  return { material: false };
}

/**
 * Looser-than-territoriesOverlap partial match used ONLY at 'high' sensitivity. An affected
 * path and a forbidden glob's static prefix that share at least one leading path SEGMENT but
 * are NOT a strict path-prefix of each other (so territoriesOverlap already returned false) are
 * a "minor stretch toward out-of-scope" — e.g. affected 'src/legacy-tool' vs forbidden
 * 'src/legacy/**' share the 'src' segment and diverge only at 'legacy-tool' vs 'legacy'. This
 * is precisely what 'high' adds over 'low'/'medium'.
 */
function partialTerritoryOverlap(affects: string[], forbidden: string[]): boolean {
  for (const a of affects) {
    const sa = globPrefix(a).split("/").filter(Boolean);
    if (sa.length === 0) return true; // a bare wildcard touches everything
    for (const f of forbidden) {
      const sf = globPrefix(f).split("/").filter(Boolean);
      if (sf.length === 0) return true;
      // number of identical leading segments
      let shared = 0;
      const depth = Math.min(sa.length, sf.length);
      while (shared < depth && sa[shared] === sf[shared]) shared++;
      // a partial overlap shares >=1 leading segment AND diverges before either runs out
      // (a full divergence point — not one being a clean prefix of the other, which the
      // strict territoriesOverlap test at the 'low' tier would already have caught).
      if (shared >= 1 && shared < sa.length && shared < sf.length) return true;
    }
  }
  return false;
}
