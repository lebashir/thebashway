---
name: thebashway
description: Use when building any new feature in a project wired for the autonomous build system - runs the intake -> spec -> parallel build -> verify -> cold-review -> integrate -> deploy loop with evidence-backed gates, dispatching bashas for the work. Triggers when asked to build, ship, or implement a feature behind the verify tooling.
---

# thebashway

The way builds happen here: trustworthy, parallel, low-supervision, autonomous
between intake and ship. Every gate is evidence the next stage checks — never a
claim taken on trust. **Evidence before assertions.**

## Two phases, two trust zones

```
INTAKE (conversational, human-touch)   →   BUILD (autonomous, no-human-touch)
goal → planning basha drafts entry         start → claim N → run the loop → ship
       → ONE confirm → queue.md            loop  → on completion, claim next
                                           park  → on a human-only Q, mark @parked,
                                                   cascade dependents, continue
                                           exit  → no claim-able items left
```

The queue is the contract. Intake's job is to produce queue entries so complete
that **build never has to interrupt**. Anything that needs the human becomes a
parked item; the loop keeps going on everything else.

## Bashas — the workers

A dispatched worker agent is a **basha**. Several at once are **bashas**. The
specialized ones are types of basha — dispatch the one that fits the job:

- **basha** — a single worker doing one well-scoped task.
- **building basha** — implements a slice (TDD, runs `verify`, commits).
- **planning basha** — drafts a spec/plan from a goal (also drafts queue entries).
- **thinking basha** — deep reasoning, analysis, debugging (no rush to code).
- **designing basha** — UI / frontend / visual design work.
- **reviewing basha** — fresh-eyes cold review (zero prior context; fixed prompt).

Always speak of them this way — "dispatch a building basha," "two bashas in
parallel," "a fresh reviewing basha."

**Model:** sonnet+ for bashas. Haiku thrashes its context on multi-file tasks.

## Intake — the only human-touch zone

The bar: **an item only enters queue.md when it can ship with zero further
questions to Bashir.**

When the user hands over a goal (a single feature, a multi-batch plan, or "fix
this"):

1. Dispatch a **planning basha** that drafts the full queue entry (or entries
   for a multi-item plan). Each entry has: `Goal`, `Territory`,
   `Done-when`, optional `DependsOn`, and a `Clarifications` block with
   **proposed defaults** for every "how" detail it filled in. Any question
   whose answer changes WHAT or WHETHER (not just HOW) goes into an `Open
   questions:` section in the preview.
2. Show the user **ONE bundled preview message** containing all entries +
   any open questions.
3. The user thumbs-up (commit as-is) or inline-tweaks specific entries; on
   confirm, `appendItem` writes the entries to `queue.md`.

Round-trip target: 1 (or 2 if the user wants tweaks). Anything that needs the
user's input MID-BUILD is intake's failure to clarify, not build's failure to
proceed.

## Run mode — autonomous queue consumption

**Who runs what.** The USER never types orchestration commands. The DRIVER
(this CC session running the skill) calls the `bun run thebashway <cmd>`
primitives via its Bash tool — they are implementation detail of the
autonomous flow, not a user-facing CLI. When the user says "go," "ship the
queue," "do the next batch," or just drops items in queue.md and invokes the
skill, the driver runs all of the following without asking:

1. **Auto-preflight (once per session):** the driver Bash-runs
   `bun run thebashway preflight <surface>` — pushes any local commits,
   regenerates derived artifacts (commits + pushes if the snapshot was stale),
   asserts no stray worktrees / orphan branches, verifies gitignored seed
   files exist.
2. **Auto-claim a batch:** the driver Bash-runs `bun run thebashway claim
   <n>` to claim up to `n` claim-able items (`@unclaimed` AND every
   `DependsOn` resolved). `n = MAX_CONCURRENT_BASHAS`. Each gets `@<session>
   / <branch>` so concurrent sessions don't collide.
3. **For each claimed item, run the per-item loop** (next section). Slices
   inside an item can run in parallel worktrees; the budget covers BOTH levels.
4. **On per-item completion**, the driver re-scans queue.md, claims the next
   claim-able item, and continues. **Does not ask. Does not stop.**
5. **Exit** when no claim-able items remain (queue empty OR everything left
   is parked OR claimed by another session). Write the session digest.

**Multi-session safety:** session id = `process.env.CLAUDE_SESSION_ID` if set,
else `$USER`. A second session started in parallel sees items claimed by the
first as `@other-session/...` and skips them, claiming the next batch instead.
Queue ops are flock'd; races can't double-claim. A claim that hasn't seen
branch commits in >6h is treated as abandoned and re-claimable.

**Auto-pickup is the default**, not a mode you toggle. The user never has to
say "next" — only "go" once (or just invoke the skill). Stops only on the
three rails (see Rails) or the circuit breaker.

## The per-item loop

For each claimed item:

1. **Spec + cold review.** A **planning basha** drafts the spec from the queue
   entry. A fresh **reviewing basha** cold-reviews it using
   `cold-review-prompt.md` (see Cold review below). Proceed only on a clean
   verdict; otherwise `park` with the reviewer's open questions.
2. **Plan + slice.** Slice into units with disjoint territories so they
   parallelize. If two units must share a file, combine them — re-merging is
   more expensive than serial execution.
3. **Spawn worktrees.** For each unit, `git worktree add` + `seedWorktree`
   (copies gitignored files from `preflight-seed.txt`). Dispatch **building
   bashas** on sonnet+, injecting the project's Active lessons into the prompt
   (`formatForPrompt(relevantLessons(...))`).
4. **Verify per unit.** Each basha runs `verify` and keeps the raw output +
   tamper-evident manifest. The driver re-checks the manifest hashes against
   git before trusting it.
5. **Cold diff review per unit.** A fresh **reviewing basha** with
   `cold-review-prompt.md` filled in: spec + diff + verify manifest + live DB
   migrations (`list_migrations` output) + project addendum. Reviewer
   classifies each finding as `INLINE-FIX` or `STRUCTURAL`.
6. **Apply findings.** **Default: driver patches `INLINE-FIX` findings inline**
   (≤30 lines, single file, no public-API change), commits as `fix(<unit>):
   ...`, re-runs verify, moves on. **Exception: bounce back to the basha for
   `STRUCTURAL` findings** (multi-file, public-API, spec deviation). Retry
   budget per unit: 1. Then `park`.
7. **Integrate serially.** Merge units one at a time through one integration
   branch; RE-RUN `verify` after each merge against the union of merged
   territories (green-in-isolation != green-integrated).
8. **Deploy + smoke** the live result. If broken, auto-roll-back; mark the
   item `@parked` with the reason.
9. **Leave no trace.** Tear down worktrees + branches; ASSERT with
   `assertClean(...)` — no stray worktree, no orphan branch matching the
   pattern.
10. **One commit per item integrated + batched NOW.md / queue.md update.**
    Per-slice `now/queue: …` commits are deprecated; batch the NOW.md update
    per N items or at session end (whichever first). The digest records:
    `item, manifest hash, review verdict, deploy result, parks, anomalies`.
    Concise summary line goes into NOW.md's running ledger.

## Park-and-continue

When a basha or driver hits a question only the human can answer (the bar is
**high** — see below), do NOT stop:

1. `bun run thebashway park "<item-title>" "<one-line-reason>"`.
2. This broadcasts to ALL surfaces the human might see:
   - **`queue.md`** — `@parked (reason)` status + `Park-reason:` line (source
     of truth). Dependents (`DependsOn: <this>`) auto-cascade to
     `@parked-on:<this>`.
   - **`NOW.md`** — `## Parked — needs your call` section at the top, one
     line per parked item.
   - **External feed** — project-wired sink (lifeofbash inserts a
     `source='thebashway'` row into `agent_events`, surfaced in the organs
     AgentFeed at lifeofbash.vercel.app).
   - **Session digest** — `Parked items:` section in the digest output.
3. **Immediately** scan for the next claim-able item and continue. Do not
   pause.
4. **Unblock** when the human edits the queue item (answers in
   `Clarifications`, flips `@parked → @unclaimed`). Run `bun run thebashway
   unpark-scan` to cascade dependents back to `@unclaimed`. No re-intake.

**The bar for parking is high.** A basha picks a reasonable default and
documents it as an assumption in the diff IF (a) the call doesn't affect
ship/no-ship, (b) it's reversible in <1h of work. Otherwise park.
- **Should park:** schema-migration semantic choice with no spec answer,
  deletion of user-facing data, third-party API key needed, behavior inversion
  that affects other features.
- **Should NOT park:** button color, log wording, test-naming convention,
  variable name choice, anything purely cosmetic.

## The gates (what `verify` enforces)

Run `bun run verify --surface <name> --base <ref> [--territory <glob> ...]`.
Emits per-check results + a tamper-evident **manifest** (diff hash, output
hash, territory). The DRIVER recomputes those hashes before trusting it.

- **Scope-diff** — changed files stay inside the declared territory.
- **Required-touches** — declared changes touch their obligated companions
  (mechanical rules in `required-touches.ts`). The judgment half is the
  cold-review checklist.
- **Freshness** — derived artifacts regenerated; any diff means stale.
- **Gate chain** — tsc + lint + tests + build, per surface.
- **Smoke** — per route: HTTP 200 + an expected positive marker (never grep
  prose for scary words); on an ephemeral port so parallel runs don't collide.

## Cold review

Use `<orchestrator-dir>/cold-review-prompt.md` (the template — projects copy
from `thebashway/template/cold-review-prompt.md` and add a project addendum).
The template carries the **fidelity preamble** that handles known reviewer
blind spots:

- DB migrations applied via Supabase MCP aren't in the diff — `list_migrations`
  is the schema source; the driver passes its output as reviewer input.
- Probes that grep rendered text must match the LITERAL `textContent` (case,
  substring traps lie).
- Interactive shape = what a USER sees (`<button>` without `onClick` is still
  a button to screen readers — render `<div>` when there's no handler).
- Existing schema may cover what looks new — cross-check live state.
- A suggested fix can be wrong; judge against actual behavior.

Reviewers MUST classify each finding as `INLINE-FIX` (driver patches) or
`STRUCTURAL` (basha retries). When unsure, default to `INLINE-FIX`.

Beyond what `verify` checks mechanically, the reviewer confirms:
- Docs that should change DID, and are CORRECT (closest `CLAUDE.md`, `NOW.md`).
- A durable learning was written if one emerged.
- Epic/slice completion updated the spec/plan status + `docs/CLAUDE.md` map.
- New cross-cutting convention updated the required-touches matrix.

## Rails (never autonomous)

The loop may build, deploy, roll back, redeploy, run schema changes. It may
NOT, without the human: (a) destroy unrecoverable data, (b) send anything that
reaches other people, or (c) deploy a change to a surface smoke cannot
exercise (background jobs, webhooks) until smoke covers it.

When a rail blocks an item, `park` it with the rail reason; the loop
continues on the next claim-able item. The user un-rails by editing the queue
item (e.g. "OK, proceed with delete: yes — confirmed").

## Loop safety

- **Per-item runaway budget:** a basha that loops (not failing) past its
  turn/tool/wall-clock budget is aborted; the item `@blocked (budget)`.
- **Circuit breaker (sliding window):** X failures in the last Y items stops
  the loop. Surfaces in the digest.
- **Retry bound:** one retry on a transient failure; reviewing-basha's
  rejection bounces work back once with feedback; then `@parked` with the
  reason — never spin, never silently drop.

## Decision-style learning — ask less over time

The driver should ask the user FEWER questions each session, not the same
number. Two mechanisms make this real:

1. **Read the user's decision-style memory at intake.** The project's
   memory dir has a `<user>-decision-style.md` file (e.g.
   `bashir-decision-style.md`) holding observed patterns — preferred
   defaults for naming, scope, autonomy, commit cadence, design choices,
   what they always-confirm vs. always-let-the-AI-decide. The intake
   planning basha reads this BEFORE drafting clarifications and pre-fills
   defaults from it. Questions whose answers are already in style memory
   do NOT get asked.
2. **Append after each session.** When the user answers a clarification,
   corrects an assumption, or just lets a default ride uncorrected, the
   driver appends a one-line observation to the style memory:
   - "Asked X → answered Y" (a stated preference)
   - "Assumed Z → not corrected over <N> items" (an inferred preference)
   - "Corrected my W to V" (a explicit redirection)

   Dedup is automatic (identical lines collapse). Confidence builds with
   repetition — an observation seen twice graduates from "noticed" to
   "default." After enough sessions, what once needed asking becomes
   inferable.

The bar for keeping a clarification in the intake preview at all is: the
style memory has NO entry that resolves this question. If it does, the
basha picks the inferred default and notes it in `Clarifications:` for
the user to overrule if they want — no preview question.

## Lessons — feed forward, kept tight

A running `<orchestrator-dir>/lessons.md` holds distilled pitfalls, each a
`- [tag] rule` line. The file is two-tier:

- **`## Active`** — lessons that are STILL learnable per-basha. Injected into
  each basha's prompt (filtered by area + `general`).
- **`## Graduated`** — lessons now encoded in code, automated by preflight, or
  moved to the cold-review prompt template. Kept for history; NOT injected.

Rules:
- **Before dispatching any basha**, read `lessons.md`, take the relevant
  Active entries, paste them as "Known pitfalls — do not repeat"
  (`formatForPrompt`).
- **When a gate or reviewing basha catches a real mistake**, `appendLesson`
  inserts a one-line lesson into `## Active` (dedup automatic).
- **Quarterly sweep** (manual): re-split Active ↔ Graduated based on whether
  each lesson is still firing. If a lesson hasn't been re-triggered in
  N items, consider it graduated.

General, cross-project lessons graduate into this skill over time.

## Documentation discipline

- Orientation/machinery docs (`CLAUDE.md`, `README`, `USAGE`, `docs/`) are the
  BUILD zone — in a dev session edit them directly and commit; do NOT file
  proposals (proposals are the OPERATE path, for life-content).
- Update `NOW.md` on every state change worth remembering. The digest's
  concise summary line goes there; the full digest goes to the run log.

## Project bindings

Project-specific knowledge lives in `<orchestrator-dir>/`, not in this skill:

- `config.ts` — surfaces + verify commands + env quirks +
  `MAX_CONCURRENT_BASHAS` + `DEFAULT_BRANCH_PATTERN`.
- `required-touches.ts` — the mechanical companion-touch matrix.
- `queue.md` — the live queue (status grammar in `queue.ts` doc-comment).
- `lessons.md` — the two-tier learning log (`## Active` + `## Graduated`).
- `cold-review-prompt.md` — the project's reviewer prompt (template + project
  addendum).
- `preflight-seed.txt` — gitignored files the worktree spawner copies on
  spawn (e.g. `.env.local`).
- `cli.ts` — the thin per-project wrapper exposing `bun run thebashway
  <subcmd>`. Wires the portable primitives to project surfaces + sinks.

A new project copies the template, swaps the bindings, keeps this skill.

See the build-system spec + the tightening spec for the full rationale:
- `docs/superpowers/specs/2026-05-27-autonomous-build-system-design.md`
- `docs/superpowers/specs/2026-05-28-thebashway-tightening-design.md`
