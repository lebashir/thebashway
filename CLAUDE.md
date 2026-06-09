# CLAUDE.md — working ON thebashway

This file is for an agent (or human) **changing thebashway's own code**. It is *not* how you
*use* thebashway to build other repos — for that, read `README.md` (setup), `USAGE.md` (full
command + settings reference), and `plugins/thebashway/skill/SKILL.md` (the agent method).
Read those if you're driving the tool; read this if you're developing the tool.

## What this project is

thebashway is a **portable autonomous build loop** — Build Mode + Fix Mode for any code repo,
driven by headless `claude` workers behind evidence-backed verify gates, with a per-project
"north star" design brief and a human-approval rail. It ships in two pieces:

- the **engine** — a Bun/TypeScript library + CLI under `src/` (run as `thebashway <verb>`);
- the **method** — a Claude Code plugin (skill + slash commands) under `plugins/thebashway/`,
  distributed via the self-hosted marketplace (`.claude-plugin/marketplace.json`).

A consuming repo supplies **one** binding (`thebashway.config.ts`) and links the engine. The two
pieces install separately on purpose: a Claude Code plugin can't run an install step, so the Bun
engine can't ride inside the plugin.

## Build / test / typecheck

- **Test (the green gate):** `bun test`. The whole suite must pass before any change is done.
- **Run the CLI locally:** `bun run src/cli.ts <verb>` or `bun run thebashway <verb>`.
- **Typecheck:** `bunx tsc --noEmit` **by hand only.** Do NOT add `tsc` to any verify chain —
  the repo runs on Bun's transpile-time checking and ships no `@types/bun`, so standalone `tsc`
  fails with TS2688 (missing bun types), not real errors. Ignore TS2688 noise; it is not a bug.
- **No build step.** `package.json` `exports` point straight at `.ts` (`./src/index.ts`,
  `./src/binding.ts`); consumers run the source under Bun.
- **CI:** `.github/workflows/ci.yml` runs `bun install --frozen-lockfile` + `bun test` on every
  PR and push to `main`. It mirrors the green gate — `tsc` is intentionally absent for the same
  TS2688 reason. Bump the pinned `bun-version` when you bump Bun locally.

## Architecture map

- `src/cli.ts` — the **verb dispatcher** and single source of truth for the command surface. It
  loads `thebashway.config.ts`, injects it (`setBinding`), derives the loop-data paths, and
  dispatches. If you add or change a command, this file and `usage()` inside it are authoritative —
  keep `USAGE.md` in sync.
- `src/binding.ts` — the **`ProjectBinding` contract** (`defineThebashway`). The one typed shape a
  consuming repo supplies; everything the engine used to hardcode arrives through it. The default
  resolver lives here (`branchPattern`, `breaker`, `maxConcurrent`, `seedPaths`, `brief`,
  `briefDriftSensitivity`, `requireBrief`).
- `src/router.ts` — `classifyMode`: auto-route a bare request to Build vs Fix.
- `src/init.ts` — `init`: detect build/test, scaffold the config + `.thebashway/` store, enable the
  plugin for the repo, and seed the brief draft.
- `src/update.ts` — `thebashway update`: `git pull --ff-only` + `bun install` on the shared clone.
- `src/sinks.ts` — `Notify` / `EventSink` / `StatusFile` (default no-ops; a binding opts in).
- `src/brief-writer.ts` — the **human-present** brief writer + gate decision + status formatter.
  INV-A: the engine never writes the brief; the only two writers are init's `seedBriefIfAbsent`
  and this file's `writeConfirmedBrief`.
- `src/engine/` — the loop internals:
  - `audit.ts` / `audit-run.ts` — **IN door (Fix)**: resolve a target, fan out finder bashas,
    adversarially verify, shape, enqueue.
  - `design.ts` / `design-run.ts` — **IN door (Build)**: design a feature, decompose into disjoint
    territories, safety-gate.
  - `drain.ts` — **OUT door**: preflight → claim → build basha → re-verify → integrate → land.
  - `headless.ts` — the reusable `claude -p` engine (subscription env scrub, timeout→SIGKILL,
    never-throws).
  - `queue.ts` / `queue-ops.ts` — the `.thebashway/queue.md` work-queue grammar + operations.
  - `brief.ts` / `load-brief.ts` / `brief-eval.ts` — the north-star brief: `gapsOf` readiness
    reader (shared by status/gate/writer), the loader, and `CheckSpec` evaluation.
  - `autonomous.ts` — `run-to-goal`: loop build→check until the brief's criteria pass, under caps.
  - `reflect.ts` / `digest.ts` — Loop C milestone reflection (human-gated brief-update proposals).
  - `verify/` — the gate: `chain`, `freshness`, `required-touches`, `smoke`, `manifest`, `scope`,
    `ports`, plus `run.ts` (`gitHead`, `bunRun`) and `index.ts` (`runVerify`).
  - `park.ts` — the human-approval **rail**: parks person-reaching / data-destroying work.
  - `capture-sweep.ts` / `auto-intake.ts` — the Stage-2 self-filling queue (`TODO(tbw)`/`FIXME(tbw)`).
  - `design-bar.ts` / `basha-prompt.ts` / `intake-prompt.ts` — prompt assembly.
  - `lessons.ts` + `lessons.md` / `decisions.md` — the Loop A/B learning stores (this repo dogfoods
    its own).
  - `config.ts` — the injected-binding accessors (`SURFACES`, `getRequireBrief`, `getDefaultSurface`, …).
- `src/__tests__/` and `src/engine/**/__tests__/` — the suite. Tests that exercise failure paths
  (a sink throwing, a finder crashing) intentionally log errors; a clean run still ends `0 fail`.

## The dogfood (thebashway builds itself)

`thebashway.config.ts` at the repo root points the engine at this repo so it can build itself.
Three non-obvious things:

- It imports `./src/binding` with a **relative** path, NOT `"thebashway/binding"` — the `init`
  template uses the package-name import, which doesn't resolve inside the engine's own repo (the
  repo isn't in its own `node_modules`). Consumer configs use the package name; see `examples/`.
- `requireBrief: false` (no human interview mid-self-build) and the verify chain is `[test]` only.
- `learning.local` / `decisions` point at `src/engine/*.md`, so a self-build feeds the **live**
  Loop A/B, not empty `.thebashway/` seeds.

## Conventions

- **Docs and specs are plain text** — no emojis, ISO 8601 dates (never relative). The existing
  markdown follows this; keep it. (The CLI prints status glyphs like the check/cross/bullet at
  runtime — that's console output, deliberately kept, not a doc convention.)
- **Evidence before assertions.** Every gate is evidence the next stage rechecks, never a claim on
  trust. Don't say a change is done without a green `bun test`.
- **Preserve the two invariants.** INV-A: the engine exports no brief writer — brief updates route
  through the human-gate (`park` + the writer). INV-B: the brief is a zod-validated TS module loaded
  by dynamic import.
- **Preserve the rails.** The loop may build / deploy / roll back / redeploy / run schema changes.
  It may NOT, without a human: destroy unrecoverable data, or send anything that reaches people.
  Those `park` even in full-auto. Deploy is **not** a rail (it's reversible). This is non-negotiable.
- **Capture lessons as you go.** When a review or gate catches a real mistake, append a one-line
  `- [tag] rule` to `src/engine/lessons.md` the moment it's caught, not at the end.

## How to develop a change here

Two ways, by size:

- **Small change:** edit + `bun test`. Run `bunx tsc --noEmit` by hand if you touched types.
- **Dogfood it:** `bun run thebashway fix src/engine/<file>` or `build "<feature>"` drives the
  change through the loop itself (per-task build bashas, cold review, verify gate). Good for a
  larger, well-scoped slice.

Confirm the baseline (`bun test`) is green **before** you start.

## Cutting a release (so consumers get the change)

The version lives in **two** files — keep them in lockstep:

1. `package.json` → `"version"`
2. `plugins/thebashway/.claude-plugin/plugin.json` → `"version"`

(`marketplace.json` carries no plugin version — nothing to bump there.)

Then:

- `git push origin main` (use the explicit form). Engine consumers pull it via `thebashway update`;
  a `bun link`ed dev consumer (e.g. a local lifeofbash checkout) gets engine changes immediately
  because it points at this working tree.
- Method (skill + slash commands) consumers refresh via
  `claude plugin marketplace update thebashway` then `claude plugin update thebashway`.

## The doc set (keep these straight)

- **Using the tool to build other repos:** `README.md` (setup), `USAGE.md` (full command/settings
  reference), `plugins/thebashway/skill/SKILL.md` (the agent method, both headless and interactive).
- **Developing the tool itself:** this file.
- **Relationship to lifeofbash (where the engine was extracted from):** `SYNC.md`.
- **Design history:** `docs/specs/` (each marked BUILT or design) and `docs/plans/`.
