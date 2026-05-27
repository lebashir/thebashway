---
name: thebashway
description: Use when building any new feature or organ in a project wired for the autonomous build system - runs the intake -> spec -> parallel build -> verify -> cold-review -> integrate -> deploy loop with evidence-backed gates. Triggers when asked to build, ship, or implement a feature behind the verify tooling.
---

# thebashway

The way builds happen here: trustworthy, parallel, low-supervision. Every gate is
evidence the next stage checks — never a claim taken on trust. The one rule under
all of it: **evidence before assertions.**

## Applicability envelope

Assumes a **JS/TS repo with a build step and HTTP routes**, a `git` working tree,
and the verify tooling at `tools/orchestrator/` (config + `verify`). Off that shape
(a Python CLI, a no-server library), adapt deliberately — smoke becomes a CLI
invocation + exit-code assertion; no build step drops the build-parity check. Do
not pretend an off-shape project is in-envelope.

## The per-item loop

1. **Intake (at add-time, with the human).** Clarify the item's SHAPE — goal,
   territory (the files it may touch), done-when. Ask only when the answer changes
   *what* gets built or *whether* to build it; decide small "how" details yourself.
   Bundle questions, ask once, record answers in the item's `Clarifications`. Write
   a self-contained entry to `tools/orchestrator/queue.md`. Intake catches scope,
   NOT defects.
2. **Claim.** Mark the item `@<session> / <branch>` in `queue.md` before working it
   (this is how concurrent sessions avoid collisions).
3. **Spec + cold review.** Draft the spec. Dispatch a FRESH agent (fixed-template
   prompt; the spec as its only input; no queue/driver/conversation access) to
   cold-review it — this is the PRIMARY defect catcher. Proceed only if clean/
   high-confidence; otherwise escalate to the human.
4. **Plan + slice.** Slice into units with disjoint territories so they parallelize.
5. **Build (parallel, <=3-4 at once).** Each unit in its own worktree + branch.
   Dispatch implementer subagents on a capable model (sonnet+; haiku thrashes here).
   Each runs `verify` and keeps the raw output + manifest.
6. **Cold diff review (per unit).** Fresh agent; input = the diff PLUS the spec it
   must satisfy; no other access. Requires the verify manifest as input.
7. **Integrate (serial).** Merge units one at a time through one integration branch;
   RE-RUN verify after each merge (green-in-isolation != green-integrated).
8. **Deploy.** Deploy; smoke the live result; if broken, auto-roll-back to the last
   good version and mark the item `@blocked` with the reason.
9. **Leave no trace.** Tear down the unit's worktree + branch; ASSERT it: `git
   worktree list` clean, no orphan branch matching the unit pattern.
10. **Digest.** Append the fixed-schema record (item, verify manifest hash, review
    verdict, deploy result, anomalies) to the run log; a concise summary to `NOW.md`.

## The gates (what `verify` enforces)

Run `bun run verify --surface <organs|tools> --base <ref> [--territory <glob> ...]`.
It emits per-check results + a tamper-evident **manifest** (diff hash, output hash,
territory). The DRIVER recomputes those hashes before trusting it — the reviewer
never self-validates.

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

Beyond what `verify` checks mechanically, the diff reviewer confirms:
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
- **Per-item runaway budget:** a looping (not failing) unit that exceeds its
  turn/tool/wall-clock budget is aborted and `@blocked (budget)`.
- **Circuit breaker (sliding window):** X failures in the last Y items stops the loop.
- **Retry bound:** one retry on a transient failure; a review rejection bounces back
  once with feedback; then `@blocked` with the reason — never spin, never silently drop.

## Project bindings

Project-specific knowledge lives in `tools/orchestrator/`, not in this skill:
`config.ts` (surfaces + verify commands + env quirks), `required-touches.ts` (the
matrix), `queue.md` (the live queue). A new project swaps those and keeps this skill.

See the full rationale in the project's build-system spec.
