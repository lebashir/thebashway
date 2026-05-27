---
name: thebashway
description: Use when building any new feature in a project wired for the autonomous build system - runs the intake -> spec -> parallel build -> verify -> cold-review -> integrate -> deploy loop with evidence-backed gates, dispatching bashas for the work. Triggers when asked to build, ship, or implement a feature behind the verify tooling.
---

# thebashway

The way builds happen here: trustworthy, parallel, low-supervision. Every gate is
evidence the next stage checks — never a claim taken on trust. The one rule under
all of it: **evidence before assertions.**

## Bashas — the workers

A dispatched worker agent is a **basha**. Several at once are **bashas**. The
specialized ones are types of basha — dispatch the one that fits the job:

- **basha** — a single worker doing one well-scoped task.
- **building basha** — implements a slice (TDD, runs `verify`, commits).
- **planning basha** — drafts a spec/plan from a goal.
- **thinking basha** — deep reasoning, analysis, debugging (no rush to code).
- **designing basha** — UI / frontend / visual design work.
- **reviewing basha** — fresh-eyes cold review (zero prior context; fixed prompt).

Always speak of them this way — "dispatch a building basha," "two bashas in
parallel," "a fresh reviewing basha."

## The per-item loop

1. **Intake (at add-time, with the human).** Clarify the item's SHAPE — goal,
   territory (the files it may touch), done-when. Ask only when the answer changes
   *what* gets built or *whether* to build it; decide small "how" details yourself.
   Bundle questions, ask once, record answers in the item's `Clarifications`. Write
   a self-contained entry to `tools/orchestrator/queue.md`. Intake catches scope,
   NOT defects.
2. **Claim.** Mark the item `@<session> / <branch>` in `queue.md` before working it
   (this is how concurrent sessions avoid collisions).
3. **Spec + cold review.** Draft the spec (a **planning basha** may do this).
   Dispatch a FRESH **reviewing basha** (fixed-template prompt; the spec as its only
   input; no queue/driver/conversation access) to cold-review it — this is the
   PRIMARY defect catcher. Proceed only if clean/high-confidence; otherwise escalate
   to the human.
4. **Plan + slice.** Slice into units with disjoint territories so they parallelize.
5. **Build (parallel, <=3-4 at once).** Each unit in its own worktree + branch.
   Dispatch **building bashas** on a capable model (sonnet+; haiku thrashes here),
   injecting the relevant lessons into each one's prompt (see Lessons). Each runs
   `verify` and keeps the raw output + manifest.
6. **Cold diff review (per unit).** A fresh **reviewing basha**; input = the diff
   PLUS the spec it must satisfy; no other access. Requires the verify manifest.
7. **Integrate (serial).** Merge units one at a time through one integration branch;
   RE-RUN verify after each merge (green-in-isolation != green-integrated).
8. **Deploy.** Deploy; smoke the live result; if broken, auto-roll-back to the last
   good version and mark the item `@blocked` with the reason.
9. **Leave no trace.** Tear down the unit's worktree + branch; ASSERT it: `git
   worktree list` clean, no orphan branch matching the unit pattern.
10. **Digest.** Append the fixed-schema record (item, verify manifest hash, review
    verdict, deploy result, anomalies) to the run log; a concise summary to `NOW.md`.

## The gates (what `verify` enforces)

Run `bun run verify --surface <name> --base <ref> [--territory <glob> ...]`.
It emits per-check results + a tamper-evident **manifest** (diff hash, output hash,
territory). The DRIVER recomputes those hashes before trusting it — the reviewing
basha never self-validates.

- **Scope-diff** — changed files must stay inside the declared territory (no overrun).
- **Required-touches** — declared changes must also touch their obligated companions
  (mechanical rules in `tools/orchestrator/required-touches.ts`). The judgment half
  is the cold-review checklist below.
- **Freshness** — regenerate derived artifacts; any change means the committed copy
  was stale (run the REAL build, never a step-skipping shortcut).
- **Gate chain** — tsc + lint + tests + build, per surface.
- **Smoke** — per route: HTTP 200 + an expected positive marker (never grep prose
  for scary words); on an ephemeral port so parallel runs don't collide.

## Cold-review checklist (the judgment half of completeness)

Beyond what `verify` checks mechanically, the reviewing basha confirms:
- Docs that should change DID, and are CORRECT (closest `CLAUDE.md`, `NOW.md`).
- A durable learning was written to memory if one emerged.
- An epic/slice completion updated the spec/plan status + `docs/CLAUDE.md` map.
- Establishing a new cross-cutting convention updated the required-touches matrix.

## Rails (never autonomous)

The loop may build, deploy, roll back, redeploy, run schema changes. It may NOT,
without the human: (a) destroy unrecoverable data, (b) send anything that reaches
other people, or (c) deploy a change to a surface smoke cannot exercise (background
jobs, webhooks) until smoke covers it.

## Loop safety

- **Intake/ask-when-unsure:** clarify shape up front; escalate rather than guess.
- **Per-item runaway budget:** a basha that loops (not failing) past its
  turn/tool/wall-clock budget is aborted and the item `@blocked (budget)`.
- **Circuit breaker (sliding window):** X failures in the last Y items stops the loop.
- **Retry bound:** one retry on a transient failure; a reviewing basha's rejection
  bounces the work back once with feedback; then `@blocked` with the reason — never
  spin, never silently drop.

## Lessons — learn from mistakes (feed forward)

A running `tools/orchestrator/lessons.md` holds distilled pitfalls, each a
`- [tag] rule` line (tag = an area, or `general`). It's the curated layer above the
per-run digest.

- **Before dispatching any basha**, read `lessons.md`, take the ones tagged
  `general` or the basha's surface/area (`relevantLessons`), and paste them into its
  prompt as **"Known pitfalls — do not repeat"** (`formatForPrompt`). Every basha
  starts knowing what bit the last ones.
- **When a gate fails or a reviewing basha catches a real mistake**, append a
  one-line lesson (`appendLesson`) — distilled to a rule, tagged. Dedup is automatic
  ("caught twice" logs once).
- General, cross-project lessons graduate into this skill over time.

## Project bindings

Project-specific knowledge lives in `tools/orchestrator/`, not in this skill:
`config.ts` (surfaces + verify commands + env quirks), `required-touches.ts` (the
matrix), `queue.md` (the live queue), `lessons.md` (the learning log). A new
project swaps those and keeps this skill.

See the full rationale in the project's build-system spec.
