# thebashway

A portable, autonomous **build system** for AI-driven software work: a *method*
(a Claude Code skill) plus an *engine* (executable gates + driver helpers) that
make building trustworthy and low-supervision — parallel where possible, with
evidence-backed gates so you stop getting surprised.

It was extracted from the `lifeofbash` project (where it was designed and
hardened against four real mid-course failures), and made reusable across any
project.

## The one idea

**Evidence before assertions.** Nothing trusts a claim — not an agent's "done,"
not a gate's "looks fine." Every stage hands the next stage **proof it re-checks**:
the changed-file set is diffed, gates emit raw output, and a tamper-evident
**manifest** (content hashes) is recomputed by the driver before anything
downstream runs.

## The loop (per piece of work)

intake (clarify shape, write a queue entry) → claim → draft spec (a **planning
basha**) → **reviewing basha** cold-reviews the spec → slice into disjoint-territory
chunks → **building bashas** build them in parallel in isolated worktrees →
**`verify`** each → a **reviewing basha** does the diff review → integrate serially,
re-verifying after each merge → deploy + smoke (auto-roll-back if broken) →
**leave-no-trace** (asserted) → digest (log + a NOW-style line).

The dispatched workers are **bashas** (a single one is a *basha*; specialized ones
are *building / planning / thinking / designing / reviewing* bashas). The "driver"
is **a Claude Code session running the `thebashway` skill** plus the helpers below —
not a standalone program calling an LLM API.

## The gates (`verify`)

For each surface, `verify` runs and emits a manifest:

- **scope-diff** — changed files stay inside the unit's declared territory.
- **required-touches** — declared changes also touch their obligated companions
  (the inverse guard; your rules).
- **freshness** — generated artifacts aren't stale; the *real* build runs.
- **gate chain** — tsc / lint / tests / build.
- **smoke** — each route returns 200 + a positive marker, on an ephemeral port.

## What's portable vs yours

| The package (portable) | Your project (wiring) |
|---|---|
| `skill/SKILL.md` — the method | `config.ts` — your surfaces + commands |
| `src/verify/*` — the gate engine | `required-touches.ts` — your rules |
| `src/{lock,queue,queue-ops,manifest-check,cleanup,breaker,digest}.ts` — helpers | `queue.md` — your live queue |
| `runVerify()` — the config-driven entry | `verify.ts` — thin entry calling `runVerify` |

## Quickstart

**Install the method (once, global):**
```bash
./install.sh        # symlinks skill/ -> ~/.claude/skills/thebashway
```
Now any Claude Code session can invoke the `thebashway` skill.

**Wire a project (for the executable gates):** see `template/README.md` — copy
the four template files into `tools/orchestrator/`, add `thebashway` as a `file:`
dependency, edit `config.ts`, and run:
```bash
bun run tools/orchestrator/verify.ts --surface app --base <ref>
```

## Layout

```
skill/SKILL.md     the portable method (install.sh symlinks it into ~/.claude/skills)
src/               the engine: verify/ (gates) + helpers + runVerify
src/verify/__tests__/   the generic test suite (bun test)
template/          copy-into-a-project starter (config, rules, queue, verify entry)
USAGE.md           day-to-day: running verify, the helper API, the rails
```

## Applicability envelope

Assumes a **JS/TS repo with a build step and HTTP routes**, a git working tree,
and Bun. Off that shape (a Python CLI, a server-less library), adapt `config.ts`
deliberately — smoke becomes a CLI exit-code check; drop the build/freshness
checks if there is no build step. The skill names these adaptations.

## Status

Extracted 2026-05-27 from lifeofbash. Engine + helpers + skill are complete and
tested (`bun test`). The autonomous *loop* is run by a session following the
skill; an unattended daemon is future work.

## License / ownership

Personal tooling. Mine-and-portable by design.
