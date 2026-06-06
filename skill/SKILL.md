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

## Operating rules for an agent

- Do **not** run `thebashway fix`/`build` on the user's behalf without their go-ahead —
  they spawn headless Claude and change code. Offer; let the user invoke.
- Use `thebashway audit-plan <target>` (no model calls) to preview what Fix would target.
- Respect the rails: never bypass a parked, person-reaching, or destructive task.

See `README.md` (plain-English setup) and `USAGE.md` (full command + settings reference).
