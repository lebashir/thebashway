# thebashway

> **STALE — reference only (as of 2026-06-04).** The live, canonical thebashway lives in
> `lifeofbash/tools/orchestrator/`. It has moved well past this extract — the staged
> self-building loop (the `@needs-intake` build-ready gate, `add`/`mark-ready` capture +
> intake, the Loop A decision store, the question-ledger, the codified drain protocol) is
> NOT here. This standalone copy froze on 2026-05-28 and has drifted on the skill and
> several files. Do not bootstrap a new project from it without reconciling against the
> in-repo source first. Kept as a historical record of the extraction.

A build system for AI-driven software work. When you let AI agents write code, they
tell you they're "done" and you get surprised later. thebashway is the discipline that
stops the surprises: a *method* (a Claude Code skill) plus an *engine* (executable gates
and driver helpers) that let agents build in parallel, with each step forced to prove its
work to the next one.

It was extracted from the `lifeofbash` project, where it was designed and hardened against
four real mid-course failures, and made reusable across any project.

## The one idea

Evidence before assertions. Nothing trusts a claim, not an agent's "done" and not a gate's
"looks fine." Every stage hands the next stage proof that the next stage re-checks: the
changed-file set is diffed, gates emit their raw output, and a tamper-evident manifest of
content hashes is recomputed by the driver before anything downstream runs.

## The loop

Each piece of work moves through one path: intake (clarify the shape, write a queue entry),
claim it, draft a spec, cold-review that spec, slice it into chunks that touch separate
territory, build those chunks in parallel in isolated git worktrees, run `verify` on each,
review the diffs, integrate serially while re-verifying after every merge, deploy and smoke
test with automatic rollback if anything breaks, assert that no mess was left behind, then
log a digest line.

The workers that do the building are called *bashas* (one is a basha; specialized kinds are
planning, building, thinking, designing, and reviewing bashas). The "driver" is a Claude Code
session running the thebashway skill plus the helpers below, not a standalone program calling
an LLM API.

Bashas learn from mistakes. Each one is primed with the project's accumulated lessons
(`lessons.md`, past pitfalls grouped by area), and a new lesson is appended whenever a gate or
a reviewing basha catches a real mistake, so later bashas don't repeat it.

## The gates (`verify`)

For each surface, `verify` runs these checks and emits a manifest:

- **scope-diff:** changed files stay inside the unit's declared territory.
- **required-touches:** declared changes also touch the companion files they oblige (the
  inverse guard, defined by your own rules).
- **freshness:** generated artifacts aren't stale; the real build actually runs.
- **gate chain:** tsc, lint, tests, build.
- **smoke:** each route returns 200 with a positive marker, on an ephemeral port.

## What's portable vs. what's yours

The left column ships with the package. The right column is the thin wiring each project adds.

| The package (portable) | Your project (wiring) |
|---|---|
| `skill/SKILL.md`, the method | `config.ts`, your surfaces and commands |
| `src/verify/*`, the gate engine | `required-touches.ts`, your rules |
| `src/*.ts` helpers (lock, queue, manifest-check, cleanup, breaker, digest, lessons) | `queue.md` (live queue) and `lessons.md` (learning log) |
| `runVerify()`, the config-driven entry point | `verify.ts`, a thin entry that calls `runVerify` |

## Quickstart

Install the method once, globally:

```bash
./install.sh        # symlinks skill/ into ~/.claude/skills/thebashway
```

Any Claude Code session can now invoke the thebashway skill.

To wire a project for the executable gates, see `template/README.md`: copy the four template
files into `tools/orchestrator/`, add thebashway as a `file:` dependency, edit `config.ts`,
then run:

```bash
bun run tools/orchestrator/verify.ts --surface app --base <ref>
```

## Layout

```
skill/SKILL.md          the portable method (install.sh symlinks it into ~/.claude/skills)
src/                    the engine: verify/ (gates) plus helpers plus runVerify
src/verify/__tests__/   the generic test suite (bun test)
template/               copy-into-a-project starter (config, rules, queue, lessons, verify entry)
USAGE.md                day-to-day: running verify, the helper API, the rails
```

## Applicability envelope

This assumes a JS/TS repo with a build step and HTTP routes, a git working tree, and Bun. Off
that shape (a Python CLI, a serverless library), adapt `config.ts` deliberately: smoke becomes
a CLI exit-code check, and you drop the build and freshness checks if there is no build step.
The skill spells out these adaptations.

## Status

Extracted 2026-05-27 from lifeofbash. The engine, helpers, and skill are complete and tested
(`bun test`). The autonomous loop is run by a session following the skill; an unattended daemon
is future work.

## License and ownership

Personal tooling. Mine and portable by design.
