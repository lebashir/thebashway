---
name: thebashway
description: Use when a repo is set up with thebashway (a thebashway.config.ts exists) and the user wants Claude to autonomously build a new feature or fix existing code with evidence-backed gates and human-approval rails. Triggers on "build/fix this with thebashway", or running thebashway build/fix.
---

# thebashway

thebashway lets Claude build and fix code in a repo on its own, safely: work happens on a
side branch, the repo's real build/tests are the evidence gate, and only passing changes
are kept. Two modes:

- **Fix Mode** (`thebashway fix <target>`) — audit a file/folder/registered target for real
  problems, then build the fixes.
- **Build Mode** (`thebashway build "<feature>"`) — design a small feature, decompose it,
  safety-gate it, and build it.

`thebashway "<request>"` auto-routes to the right mode.

## When to use this skill

- The repo has a `thebashway.config.ts` (run `thebashway init` first if not).
- The user asks to autonomously build or fix code through thebashway.

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

See `README.md` (plain-English setup) and `USAGE.md` (full command + settings reference).
