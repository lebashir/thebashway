// src/engine/design-bar.ts
// The "design bar": the standing design-quality block every build basha carries, plus the
// UI-territory heuristic the drain uses to route UI work to the stronger model.
//
// This is the PORTABLE (project-agnostic) copy — it points at "the project's design system, if one
// exists" rather than naming a specific kit. A consuming repo with its own system (e.g. lifeofbash
// names Glass) keeps its own copy; the two files legitimately differ. See SYNC.md and the
// 2026-06-06 design-quality-integration spec.
//
// Scope: GENERATION guidance only. Any downstream design check is source/diff-level; rendered
// visual quality is not machine-verified and stays a human responsibility — never claim a visual
// sign-off the loop cannot back with pixels.

/**
 * The standing design block. Appended AFTER the task body (read last, before acting) and opening
 * with a hard short-circuit so it is an honest no-op for purely backend/logic work — no surface
 * detector, just self-determination (the build basha knows whether its task renders anything).
 */
export const DESIGN_BAR = `Design bar — build it beautiful, not generic (read this LAST, right before you act):
If this task produces NO user-facing UI or visual output, ignore the rest of this section.

When your work renders anything a person sees, meet this bar — never ship generic "AI-slop" UI:
- READ THE PROJECT'S DESIGN SYSTEM FIRST, if one exists (a design-system doc, a UI kit / component
  library, design tokens, a theme). Obey it — it WINS over the generic guidance below; use its
  primitives and tokens rather than re-implementing or hardcoding values.
- Typography: deliberate type — pairing, weight, rhythm. A default system font is not "a choice".
- Color & theme: a cohesive palette through tokens/variables. No hardcoded values when a token
  exists; no stray new colors.
- Spatial composition: real hierarchy, intentional spacing on a consistent scale, breathing room.
- Motion: purposeful micro-interactions and entrance/transition states where they add clarity.
- Atmosphere & detail: depth, texture, and considered empty / loading / error states — not bare
  boxes.

Generic AI-slop to AVOID: undifferentiated cards, default fonts, timid evenly-spread palettes,
cliched purple-on-white gradients, missing states, no hierarchy, copy-paste component shapes.

Reconciliation: where a design system already exists, EXTEND it coherently and refine — do not
invent a new aesthetic per component. Only on a genuinely greenfield surface should you commit to
a fresh, distinctive, intentional direction.

If the 'frontend-design' skill is available, invoke it for the full treatment. This is generation
guidance; get it right HERE — any downstream checks are source-level only, not a visual sign-off.`;

/**
 * Matches a territory glob that plausibly renders UI: a frontend file extension or a conventional
 * UI directory. A cheap file-extension/path heuristic — it only decides which MODEL the drain
 * dispatches (UI → the stronger model), never whether the design bar appears.
 */
const UI_TERRITORY = /\.(tsx|jsx|vue|svelte|css|scss|sass|less)(\b|$)|(^|\/)(components|ui|views|pages|styles)\//i;

/** True if any territory glob looks like UI work (used to pick the designing-basha model). */
export function isUiTerritory(globs: readonly string[]): boolean {
  return globs.some((g) => UI_TERRITORY.test(g));
}
