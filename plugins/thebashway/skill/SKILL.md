---
name: thebashway
description: Use when building, fixing, or shipping a feature with thebashway — either headless (running thebashway build/fix/run-to-goal so the engine spawns workers) or interactively in a live session (you, the agent, dispatch typed bashas and fold cold reviews for a larger multi-wave build). Triggers on "build/fix/ship this with thebashway", running thebashway build/fix/run-to-goal, or any in-session basha-orchestrated build behind the verify gate.
---

# thebashway

The way builds happen: trustworthy, parallel, low-supervision. Every gate is evidence
the next stage checks — never a claim taken on trust. The one rule under all of it:
**evidence before assertions.** Work happens on a side branch, the repo's real
build/tests are the evidence gate, and only passing changes are kept.

## Two ways to drive thebashway

There are two ways to run a build, and you choose by task size and how much steering you
want:

- **(a) Headless one-command** — `thebashway fix`/`build`/`run-to-goal`. The engine spawns
  headless `claude` workers, verifies each against the repo's own build/test chain,
  integrates only green changes, and lands (or stages with `--no-land`). Best for small,
  well-scoped, autonomous tasks you want to hand off and walk away from.
- **(b) Interactive in-session basha orchestration** — YOU, the agent in a live session,
  dispatch typed bashas, fold cold reviews, and integrate by hand. Best for large
  multi-wave builds where you want to steer between waves, review intermediate diffs, and
  react to findings as they land.

**When to use which.** Reach for headless when the task is contained and the spec is clear
enough that you trust the engine to drive end to end unattended; reach for interactive when
the build is big, branches into several waves, touches design/taste, or needs a human in the
loop between stages. Both honor the same gates, the same rails, and the same
evidence-before-assertions rule — they differ only in who holds the build: the engine, or you.

---

# Mode (a): headless one-command

thebashway lets Claude build and fix code in a repo on its own, safely. Two sub-modes:

- **Fix Mode** (`thebashway fix <target>`) — audit a file/folder/registered target for real
  problems, then build the fixes.
- **Build Mode** (`thebashway build "<feature>"`) — design a small feature, decompose it,
  safety-gate it, and build it.

`thebashway "<request>"` auto-routes to the right mode.

## When to use this skill

- The repo has a `thebashway.config.ts` (run `thebashway init` first if not).
- The user asks to autonomously build or fix code through thebashway, OR to drive a larger
  in-session basha build (mode b).

## The method (what the tool does)

1. **Set up** — `thebashway init` detects how the repo builds/tests and writes the config.
2. **In door** — Fix audits a target into completable items; Build designs + decomposes a
   feature into gated tasks.
3. **Out door** — each item is built by a headless `claude` on a fresh branch, verified
   against the repo's own build/test chain, integrated only if green, then landed (or
   staged with `--no-land`).
4. **Rails** — any task that reaches a person or destroys data is set aside for human
   approval, never built automatically. This is non-negotiable.
5. **Learning** — mistakes a gate catches are recorded so they aren't repeated.
6. **Design quality, built in** — every build carries a design bar, so UI work aims to be
   genuinely well-designed (extend the project's design system, no generic "AI-slop"), and UI
   tasks build on the stronger model. `thebashway fix <target> --design` audits a target for
   design-quality issues (advisory — always set aside for human review). Source-level only; not a
   visual sign-off.
7. **North star — the per-project design brief** — `thebashway init` always drafts
   `.thebashway/brief.ts` (the project's living definition / guiding light), inferring what the
   repo betrays: purpose from package.json/README, conventions from the detected build/test/deploy
   chain + scripts, and candidate glossary terms from the README/name (with placeholder meanings —
   it never invents a meaning; an unconfident term is a `# GAP`). Build and audit read the brief as
   design context so the work bends toward the project's actual purpose, vocabulary, and habits — not
   just "tests green." Autonomous-to-goal mode (`runToGoal`) drives toward the brief's
   `successCriteria`, aimed at a slice (part) or the whole set (all). `thebashway brief` is the
   non-interactive companion: it (re)seeds the draft and prints the gap list. The brief is LIVING
   but never silently rewritten — updates are PROPOSED through the human-gate.

### The brief interview (agent-driven, non-technical, after init)

No CLI command can hold a conversation, so the react-to-draft interview is YOUR job as the agent,
after `thebashway init`. It is non-technical, progressive, and infer-first, in three concentric
rings. The owner answers in plain language; YOU map the answers to the schema behind the scenes
(they never see `inScopeSurfaces` or `CheckSpec`).

**The gate funnel.** After `init`, `thebashway build`/`fix`/`run-to-goal` are GATED — they refuse to
run until the north star is confirmed and instead print a one-line nudge back to `thebashway brief`.
So when the owner finishes `init` (or hits the gate), lead them straight into this interview rather
than letting them stall. (A repo can opt out with `requireBrief:false`, and any single run can
bypass with `--skip-brief`, but the default path is: interview → confirm → build.) READ BACK every
mapped answer before writing — you translate plain language into schema, so confirm you captured it
right before it lands in the brief.

- **Ring 1 — the five always-asked core questions** (each maps to schema fields):
  - "In a sentence — what is this for?" → `purpose` (+ `narrative`)
  - "Who is this for?" → `whoServed`
  - "What's the core of it — the part that, if it broke, the whole thing is pointless?" → `scope`,
    `inScopeSurfaces`
  - "What is explicitly NOT this project — what should it never turn into?" → `limits`,
    `forbiddenSurfaces`, `forbiddenTerritory`
  - "How would YOU check it's working — what would you look at, click, or see?" → `successCriteria`.
    Stay in plain language; NEVER ask the owner for a shell command. TRANSLATE the obvious, DEFER
    the rest:
    - When the answer maps cleanly to something the repo already runs — "tests pass" → the verify
      chain / `bun test`, "the build is green" → the build command — capture it as a `command` (or
      `verify`) CheckSpec and READ IT BACK to confirm ("so I'll check that by running `<cmd>` —
      does that capture it?").
    - Otherwise capture the plain goal as a `milestone` (human-judged) and leave the
      `echo REPLACE-ME && exit 1` `command` placeholder in place. Tell the owner filling it later is
      an OPTIONAL "make-it-autonomous-ready" step, never a blocker — the brief still loads, guides,
      and confirms with the placeholder present; only hands-off autonomous-to-goal stays disabled
      until a developer fills it. Never dead-end, and never push the owner to write a command.
- **Ring 2 — inferred-and-confirmed conventions & glossary.** Do NOT ask these cold. PRESENT the
  inferred draft ("I see you use `<runner>`, tests run with `<test cmd>`; I wrote that down as
  how-we-work — anything to add or correct?" and "Here are the terms I picked up: `<term>` — what
  does that mean to you?"). The owner confirms, edits, or fills the `# GAP`s in plain language.
- **Ring 3 — grown over the project's life (throttled).** Conventions and glossary are not finished
  at init. As the project runs, milestone reflection PROPOSES additions — routed through the
  human-gated park/sink path, never auto-written, fired only on an explicit milestone marker,
  batched into one proposal, and rate-limited while a proposal is already parked.

On confirmation, do NOT hand-edit `brief.ts`. Call `thebashway brief write --from <file>` with the
agreed fields as JSON (`confirmed: true`) — it validates at the boundary and writes the brief
through `writeConfirmedBrief`, the second of the two writers the brief is allowed (the first being
init's `seedBriefIfAbsent`). Write the JSON to a temp file and point `--from` at it. The command
recomputes the gap list canonically, refuses a premature confirm (it rejects `confirmed:true` while
any Ring-1 core field is still empty), and prints what remains. The engine itself exports NO brief
writer (INV-A), so this is always a human-gated write, never an engine auto-write. While
`confirmed:false`, the brief still injects as advisory context but never hardens into drift teeth
and never lets autonomous mode terminate on the goal.

**Save as you go (resumable).** After each ring — or any time the owner pauses — call
`thebashway brief write --from <file>` with the fields gathered so far and `confirmed: false`. That
persists a partial draft so nothing is lost. On resume, run `thebashway brief` to see the remaining
gaps, then ask ONLY those — never re-ask what's already filled.

## Operating rules for an agent

- Do **not** run `thebashway fix`/`build` on the user's behalf without their go-ahead —
  they spawn headless Claude and change code. Offer; let the user invoke.
- Use `thebashway audit-plan <target>` (no model calls) to preview what Fix would target.
- Respect the rails: never bypass a parked, person-reaching, or destructive task.
- The brief is LIVING but its updates are PROPOSED and human-gated, throttled to milestone markers —
  never silently rewrite the vision to make a misaligned ask fit, and never auto-append conventions
  or glossary to `brief.ts`.
- The alignment / drift warning is ADVISORY and never blocks: it flags only a MATERIAL core-scope
  contradiction (out of inScopeSurfaces, in forbiddenSurfaces, in forbiddenTerritory). Real bugs
  (correctness findings) are never gated on the vision.
- An unfilled `command` success placeholder is an EXPECTED cold-start state — the brief still loads
  and guides; only autonomous-to-goal stays disabled until a developer fills the placeholder.

---

# Mode (b): interactive in-session basha orchestration

For a large multi-wave build, you drive the loop yourself in a live session: dispatch typed
bashas, fold cold reviews, integrate by hand. Same gates, same rails — you hold the build
instead of the engine.

## Bashas — the workers

A dispatched worker agent is a **basha**. Several at once are **bashas**. The specialized ones
are types of basha — dispatch the one that fits the job:

- **basha** — a single worker doing one well-scoped task.
- **building basha** — implements a slice (TDD, runs the verify chain, commits).
- **planning basha** — drafts a spec/plan from a goal.
- **thinking basha** — deep reasoning, analysis, debugging (no rush to code).
- **designing basha** — UI / frontend / visual design work.
- **reviewing basha** — fresh-eyes cold review (zero prior context; fixed prompt).

Always speak of them this way — "dispatch a building basha," "two bashas in parallel," "a fresh
reviewing basha."

**Model per role — reason properly, execute fast.** Match the model to the work; choose for
quality and speed:

- **The most capable model (Opus)** for the judgment-heavy roles — **planning**, **thinking**,
  **designing**, **reviewing**. Reasoning, design, planning, and cold review are where quality
  is won; do them properly.
- **A fast model (Sonnet)** for **building** bashas — once a slice is well-specified, execution
  should be quick. **Never the smallest/cheapest model for build work** (it thrashes).
- A plain **basha** takes whatever fits its task (reasoning → the capable model, mechanical →
  the fast one).

## The cold-review fold (the primary defect catcher)

A fresh **reviewing basha** with ZERO prior context stress-tests the work — this is the primary
defect catcher, not a rubber stamp:

- **Fixed-template prompt.** The reviewing basha gets a fixed prompt and only the artifact it must
  judge — no queue, driver, or conversation access. Fresh eyes are the whole point; don't leak
  context that lets it rationalize.
- **Review the spec, then the diff.** Cold-review the spec before building (proceed only if
  clean/high-confidence; otherwise escalate to the human). After each unit builds, cold-review the
  diff PLUS the spec it must satisfy — the diff alone can't reveal a missing requirement.
- **Fold real findings back BEFORE integrate.** Triage the findings; fold genuine ones into the
  work and re-verify before merging. A reviewing basha's rejection bounces the work back once with
  feedback, then `@blocked` with the reason — never spin, never silently drop.
- **The reviewing basha never self-validates.** YOU (the driver) recompute the verify manifest
  hashes before trusting the result.

## Evidence before assertions

Never claim done on trust. Each building basha runs the repo's verify chain and keeps the raw
output + manifest; you recompute the hashes before believing them. Green-in-isolation is not
green-integrated — RE-RUN verify after each serial merge onto the integration branch. A conflict
between two declared-disjoint units means they were mis-sliced: park the second, capture a lesson,
re-slice. No screenshot, no log, no manifest → not done.

## The interactive per-item loop

1. **Shape the item.** Goal, territory (the files it may touch), done-when. Ask the human only when
   the answer changes *what* gets built or *whether* to build it; decide small "how" details
   yourself.
2. **Spec + cold review.** Draft the spec (a **planning basha** may do this). Dispatch a fresh
   **reviewing basha** to cold-review it. Proceed only if clean/high-confidence.
3. **Slice.** Cut into units with disjoint territories so they parallelize.
4. **Build (parallel).** Each unit in its own worktree + branch; dispatch **building bashas** on the
   fast model, injecting the relevant lessons into each prompt (see capture-as-you-go). Each runs
   the verify chain with its declared territory and keeps the raw output + manifest.
5. **Cold diff review (per unit).** A fresh **reviewing basha**; input = the diff PLUS the spec it
   must satisfy. Fold real findings, re-verify.
6. **Integrate (serial).** Merge units one at a time through one integration branch; RE-RUN verify
   after each merge.
7. **Deploy + smoke** (if the surface supports it); auto-roll-back on a broken smoke.
8. **Leave no trace.** Tear down each unit's worktree + branch; assert the tree is clean.

## Reading the design system before UI work

Before a basha renders anything a person sees, it must read the project's design system, if one
exists — the binding's `designBar` or the repo's design-system doc — and EXTEND it: deliberate
type, tokens not hardcoded values, real hierarchy, purposeful motion, considered empty/loading/error
states. Never ship generic AI-slop. Route UI work to the **designing basha** on the capable model;
design quality is won by capability, not by a fast model. Cold review judges UI diffs against that
design system, but source-level only — rendered/visual quality is NOT machine-verified and stays a
human-review responsibility. The loop must never claim a visual sign-off.

## Capture-as-you-go (feed forward)

The project keeps a local lessons store — distilled pitfalls, each a `- [tag] rule` line (tag = an
area, or `general`). It is the curated layer above any per-run digest.

- **Before dispatching any basha**, load the relevant lessons (standing project rules + the known
  pitfalls for this basha's area) and inject them into its prompt. Every basha starts knowing what
  bit the last ones.
- **When a gate fails or a reviewing basha catches a real mistake**, append a one-line lesson —
  distilled to a rule, tagged — to the lessons store. Dedup so "caught twice" logs once.
- General, cross-project lessons graduate into this skill over time.

## Rails (never autonomous — both modes)

The loop may build, deploy, roll back, redeploy, run schema changes. It may NOT, without the human:
(a) destroy unrecoverable data, (b) send anything that reaches other people, or (c) deploy a change
to a surface smoke cannot exercise (background jobs, webhooks) until smoke covers it. Destroying
unrecoverable data, or sending anything that reaches real people, always PARKS for the human — even
in full-auto.

## Loop safety

- **Ask-when-unsure:** clarify shape up front; escalate rather than guess.
- **Per-item runaway budget:** a basha that loops (not failing) past its turn/tool/wall-clock budget
  is aborted and the item `@blocked (budget)`.
- **Circuit breaker (sliding window):** X failures in the last Y items stops the loop.
- **Retry bound:** one retry on a transient failure; a reviewing basha's rejection bounces the work
  back once with feedback; then `@blocked` with the reason.

---

See `README.md` (plain-English setup) and `USAGE.md` (full command + settings reference).
