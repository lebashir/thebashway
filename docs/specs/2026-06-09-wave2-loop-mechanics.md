# Spec — Wave-2 loop mechanics (Loop A writer, Loop B headless capture, per-surface views)

Status: DRAFT (awaiting cold review)
Date: 2026-06-09
Branch: `tbw/wave2-loop-mechanics`
Baseline: 436 tests pass on `main` (`c685a2a`).

## Why

thebashway has two learning loops. Loop A (`decisions.md`) drops the per-item
*question rate*; Loop B (`lessons.md`) drops the *failure rate*. Both feed FORWARD into
future bashas (`buildIntakePromptFromDisk` injects decisions; `buildBashaPromptFromDisk`
injects lessons). Today the WRITE side of each loop is partial:

- **Loop A has no writer.** `decisions.md` is hand-edited; the engine only ever *reads* it.
- **Loop B's headless writer is partial.** In `drain`, `appendLessonFn` fires only on an
  integration **mis-slice** (`drain.ts:349`). A build failure, a unit verify failure, or a
  non-mis-slice integration failure capture nothing — the next basha repeats the mistake.
- **No per-surface view of the queue.** `drain --surface` and `verify --surface` exist, but
  there is no read-only way to see the one queue split into its build lanes (organs vs tools).

This spec adds the three writers/views. All three are contained, mostly-pure, and live in the
package; lifeofbash consumes them via `bun link`.

## Non-goals

- No autonomy change (`run-to-goal` stays as is). These are mechanics, not new triggers.
- No board/Supabase work (that is Wave-2 #4, a separate lifeofbash epic).
- No change to how decisions/lessons are READ or INJECTED — only the write/view side.

---

## Feature 1 — Loop A writer: `appendDecision` + `add-decision` verb

**Design.** `decisions.md` reuses the `Lesson` shape and `appendLesson`'s insertion logic
(dedup + `## Active`-section-aware append). The only Loop-A-specific behavior is the global
tag: `intake-prompt.ts` unions tag `"decision"` (always-on) with the item's areas. So the
mirror writer's one meaningful distinction over `appendLesson` is its **default tag**.

- Add `appendDecision(path, { tag?, rule }): Promise<boolean>` to `lessons.ts`. When `tag` is
  omitted it defaults to **`"decision"`** (the always-on global tier), then delegates to
  `appendLesson` (one insertion implementation, DRY). Returns `false` on dedup, like its mirror.
- Add CLI verb **`add-decision "<rule>" [--tag <tag>]`**. The positional is the rule text; an
  explicit `[tag]`-prefixed positional (e.g. `add-decision "[tools] prefer X"`) is parsed into
  tag+rule (same `^\[([^\]]+)\]\s*(.*)$` form `appendLessonFn` already uses), and `--tag`
  overrides. With no tag from either source → `"decision"`. Writes to `paths.decisionsPath`.
  Prints `recorded decision [<tag>]: <rule>` (or `already recorded (no-op): <rule>` on dedup).

**Why a named `appendDecision` rather than a raw `appendLesson(decisionsPath, …)` alias:** the
default-tag-`decision` behavior is the seam where Loop A's "always-on global default" semantics
live; a future tweak (e.g. validating that a decision is phrased as a rule) has one home.

**Territory:** `src/engine/lessons.ts`, `src/cli.ts`, `src/engine/__tests__/lessons.test.ts`
(or a new `decisions.test.ts`), `src/__tests__/cli.test.ts`.

**Done-when:** `appendDecision` defaults tag to `decision`, dedups, respects `## Active`;
`add-decision` verb writes to `decisionsPath`, parses `[tag]`, honors `--tag`, dedups; usage
text updated; `bun test` green.

---

## Feature 2 — Loop B headless capture seam in `drain`

**Goal.** When a basha's work fails a gate, capture a distilled `- [tag] rule` lesson via the
existing `appendLessonFn` seam — beyond today's mis-slice-only capture — so the next basha on
that surface sees it.

**Feed-forward tagging (correctness, not cosmetic).** `drain.runBasha` injects lessons with
`buildAreas: [cfg.surface]`, and `relevantLessons` selects tag `"general"` + the item's areas.
So a captured lesson reaches future bashas ONLY if tagged with the **surface name** (e.g.
`organs`/`tools`/`engine`) or `general`. A failure-class tag like `[verify]` would never
inject. Therefore every synthesized capture is tagged with `cfg.surface`. (Observation: the
existing mis-slice lesson is tagged `[integration]` and so never feeds forward — re-tag it to
`[<surface>]` in this change; same path, trivial, restores its intended purpose.)

**Two capture sources, composed:**

1. **Basha-emitted (highest quality).** Extend the building-basha prompt (`runBasha` taskBody)
   with: *"If a gate (typecheck/test/lint) caught a non-obvious mistake you had to fix — or
   you are blocking on one — emit ONE extra final line: `LESSON: [<surface>] <one-line rule>`
   so the next basha avoids it."* Parse it via `parseMarker(stdout, "LESSON")` (already exists),
   surface it on `BashaOutcome` as `lesson?: string`. The core routes it through
   `appendLessonFn` whenever present — on a `DONE` (it overcame a pitfall; capture-as-you-go) or
   a `BLOCKED` (it authored the failure). This is the literal "the failing basha emits" path.

2. **Synthesized fallback (guaranteed coverage on a gate failure the basha didn't explain).**
   On a **unit verify failure** or a **non-mis-slice integration failure** — where the basha
   returned `DONE` but the gate disagreed — synthesize a `[<surface>]` lesson from the structured
   reason drain already holds:
   - verify-fail: `[<surface>] "<title>" passed the basha's self-check but failed drain's
     re-verify (<reason>) — the basha's verify run and the gate's diverged; assert the failing
     case before re-claiming.`
   - integration-fail (non-mis-slice): `[<surface>] "<title>" verified alone but the integration
     re-verify failed (<reason>) — a cross-unit interaction the unit verify missed.`
   No synthesized fallback on a plain build-fail (often a transient timeout after the one retry;
   rely on the basha's own `LESSON:`/`BLOCKED` text). Mis-slice keeps its dedicated lesson, re-
   tagged to the surface. Dedup (in `appendLesson`) collapses repeats; the breaker bounds volume.

**Seam shape.** `BashaOutcome` gains optional `lesson?: string`. The core `drain` calls
`appendLessonFn` in the relevant branches. `appendLessonFn` already parses `[tag] rule`. All of
this is testable on the injected-seam `drain` core: a fake `runBasha` returning a `lesson`, or a
fake `verifyUnit` returning `{ok:false}`, asserts `appendLessonFn` was called with the expected
line. `defaultDrainDeps.runBasha` wires the real `parseMarker` + the prompt addition (not unit-
tested, like its siblings).

**Territory:** `src/engine/drain.ts`, `src/engine/__tests__/` (the drain core tests).

**Done-when:** a basha-emitted `LESSON:` is routed through `appendLessonFn`; a unit-verify
failure and a non-mis-slice integration failure each synthesize a `[<surface>]` lesson; mis-slice
lesson re-tagged to the surface; no capture on transient build-fail-without-lesson; new tests
cover each branch on the `drain` core; `bun test` green.

---

## Feature 3 — Per-surface build view: `queue` verb

**Goal.** A read-only view of the one queue split into per-surface build lanes — the lean
"build-queue split" without forking the queue.

**Lane logic — EXHAUSTIVE partition (cold-review finding #1, the one real correctness fix).**
A pure `queueView(items, surfaces)` (new `src/engine/queue-view.ts`), where
`surfaces: Array<{ name: string; dir: string }>` (NOT just names — `inSurface` needs each `dir`;
the CLI maps `Object.entries(binding.surfaces)` preserving insertion order, which fixes lane
order). Each item lands in **exactly one** bucket:

```
laneOf(item, surfaces):
  if item.territory.length === 0            → "unrouted"          // every @needs-intake capture; no lane yet
  matched = surfaces.filter(s => inSurface(item, s.dir))  // exported from queue-ops; "." matches all non-empty
  if matched.length === 1                   → matched[0].name     // routed to that one surface lane
  else                                      → "other"             // 0 matches (under no surface) OR >1 (spans surfaces)
```

The `else` is the catch-all the original three-bucket design missed: a multi-surface item
(`["organs/x/**","tools/y/**"]` — which `design-run` enqueues with `itemAreas:["tools","organs"]`)
matches neither lane via `inSurface` (which requires EVERY glob under one dir), and a sub-of-no-
surface item (`["docs/x.md"]`) matches none — both go to `other`. **Invariant (asserted in a test):
every item lands in exactly one bucket; the sum of all bucket sizes equals the item count.**
A single root-`.` surface (the dogfood `engine`) → `matched.length===1` for every routed item →
one lane (correct, degenerate). A `.` surface MIXED with subdir surfaces would make `.` match
everything → `matched>1` → `other`; no shipped binding mixes them, so this is a safe fallback,
not a path to optimize.

- `QueueView = { lanes: Record<surfaceName, QueueItem[]>, unrouted: QueueItem[], other: QueueItem[] }`,
  `lanes` keyed in the surfaces-array order. The CLI groups a lane's items by status for display
  (build-ready `unclaimed`, in-flight `claimed`, `blocked`, `parked`/`parked-on`, `needs-intake`,
  `done`).

**CLI verb `queue [--surface <s>] [--json]`:**
- No `--surface`: a per-lane summary — for each configured surface, counts by status + the
  build-ready titles; then the `unrouted` (needs-intake) and `other` buckets with counts.
- `--surface <s>`: just that lane's items, grouped by status (errors if `s` is not a configured
  surface, listing the valid ones — mirror `drain`/`preflight`).
- `--json`: the structured `queueView` result.

Root-dir (`.`) surfaces (e.g. the package's own `engine`) put every routed item in one lane —
correct and degenerate. The organs/tools split lights up under lifeofbash's binding.

**Territory:** `src/engine/queue-view.ts` (new), `src/engine/queue-ops.ts` (export `inSurface`),
`src/cli.ts`, `src/engine/__tests__/queue-view.test.ts`, `src/__tests__/cli.test.ts`.

**Done-when:** `queueView` lanes items correctly (routed / unrouted / other) reusing `inSurface`;
`queue` verb prints the summary and the `--surface` filter and `--json`; unknown surface errors;
usage updated; `bun test` green.

---

## Slicing (avoid the cli.ts mis-slice)

Features 1 and 3 BOTH edit `cli.ts` (new verb + dispatch + usage). Feature 2 does NOT touch
`cli.ts`. To avoid a declared-disjoint conflict on `cli.ts`, the driver implements all three
directly with TDD (each is small; the operating-lessons rule "small fixes → driver inlines,
combine sub-bashas that touch the same file" applies). Cold review is the quality gate, run as
fresh reviewing bashas on the spec and on the full diff.

## Verify

`bun test` (the dogfood verify chain — `[test]` only; standalone `tsc` is intentionally out of
the chain per the binding's note). Driver also runs `bunx tsc --noEmit` by hand as an extra
typecheck (won't gate — TS2688 bun-types noise — but real new type errors are visible).

## Cold-review folds (2026-06-09, two independent lenses)

Both lenses verified the load-bearing claims against code (feed-forward tagging is correct;
`"decision"` default-tag is correct; `BashaOutcome.lesson?` and exporting `inSurface` are
non-breaking; no verb collisions). Build constraints folded in:

- **F3 lane partition** made exhaustive (above) — the one real correctness fix; assert the
  sum-of-buckets invariant + a multi-surface (`examples/lifeofbash.config.ts`) test.
- **F3** `queueView` takes `{name,dir}[]`; lanes ordered by surface insertion order.
- **F1/F3** add explicit `case "add-decision":` / `case "queue":` arms BEFORE the `default`
  classifier fall-through; a `cli.test.ts` case proves each does not route to build/fix.
- **F2** the mis-slice re-tag MUST keep the substring `mis-slice` in the body (the only
  lesson-asserting test, `drain.test.ts`, keys on it). The `runBasha` prompt interpolates the
  real `cfg.surface`, not the literal `<surface>`. Both a basha `LESSON:` and a synthesized
  lesson may fire for one item — intended; do not suppress. A basha emission with no `[tag]`
  lands as `general` (still injects) — acceptable.
- **Docs** add a `decisions.md` bullet to USAGE's "learning stores" section (it currently lists
  only `lessons.md`).

## Docs touched in the same change (docs-currency rule)

`README.md`/`USAGE.md` command reference (new `add-decision` + `queue` verbs), `CLAUDE.md`
(work-on-thebashway map if the verb set is enumerated), and the `usage()` text in `cli.ts`.
