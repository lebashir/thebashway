# thebashway — full reference

For the friendly intro, see [README.md](./README.md). This file is the complete command
and settings reference.

## Commands

| Command | What it does |
|---|---|
| `thebashway init [--global <path>]` | Detect how the repo builds, write `thebashway.config.ts` + a `.thebashway/` store. `--global` points the shared lessons file at a cross-project store. |
| `thebashway fix <target> [--dry-run] [--no-land]` | **Fix Mode.** Audit a target (a file, a folder path, or a registered name), then build the findings. Builds AND deploys by default. `--dry-run` audits without building. `--no-land` stops at a green branch instead of merging + deploying. |
| `thebashway build "<feature>" [--dry-run] [--no-drain] [--no-land]` | **Build Mode.** Design → decompose → safety-gate → build a small feature, then deploy it by default. `--dry-run` designs + prints only. `--no-drain` enqueues without building. `--no-land` builds + integrates but stages instead of deploying. |
| `thebashway "<request>"` | Auto-route the request to Build or Fix. |
| `thebashway audit-plan <target>` | Print the resolved plan for a target as JSON. Makes no model calls. |
| `thebashway update` | Update the thebashway clone in place: `git pull --ff-only` + `bun install`. Reaches every project that uses it (they share the one clone); per-project config/state is untouched. Refuses on a dirty tree or a non-git install. |
| `thebashway check-sync` | Report commits to the lifeofbash engine since this package was last reconciled (drift). |
| `--config <path>` | (Any command) use a binding file other than `./thebashway.config.ts`. |

A `target` for `fix`/`audit-plan` is either a **registered name** (a key in
`auditTargets`) or a **repo-relative path** that contains a `/` (e.g.
`src/components/Cart.tsx`).

## The settings file (`thebashway.config.ts`)

`init` writes this; you usually only touch `surfaces.*.chain`. Full shape:

```ts
import { defineThebashway } from "thebashway/binding";

export default defineThebashway({
  repoRoot: import.meta.dir,
  defaultSurface: "app",          // ambiguous work lands here; must be a surface key

  surfaces: {                     // one entry per buildable area of the repo
    app: {
      dir: ".",                   // path from repoRoot
      role: "...",                // prose Build Mode reads to choose a home
      chain: [                    // the gate: commands run in order; non-zero = fail
        { name: "typecheck", cmd: ["pnpm", "exec", "tsc", "--noEmit"] },
        { name: "test",      cmd: ["pnpm", "test"] },
        { name: "build",     cmd: ["pnpm", "build"] },
      ],
      derived: [],                // optional: committed files kept in sync
      regen: null,                // optional: command that regenerates `derived`
      smoke: null,                // optional: prod-render smoke on an ephemeral port
      needsRealInstall: false,    // true if a worktree needs a real install (e.g. Turbopack)
      stageNotDeploy: false,      // true to stage for review instead of auto-deploying
    },
  },

  rails: {                        // the safety gate (see below)
    territoryGlobs: [],           // folders that are person-reaching by default
    keywords: /\b(send|email|message|delete|destroy)\b/i,  // reach-a-person / lose-data only — NOT deploy
  },

  learning: {
    global: null,                 // shared cross-project lessons file (read), or null
    local: ".thebashway/lessons.md",     // this repo's lessons (read + write)
    decisions: ".thebashway/decisions.md",
  },

  sinks: { /* notify, eventSink, statusFile — all optional, default no-ops */ },
  breaker: { maxFailures: 2, window: 3 },
  maxConcurrent: 6,
  seedPaths: [],                  // gitignored files a worktree needs (e.g. .env.local)
});
```

## The safety rails

Before anything is built unattended, every task is checked against `rails`:

- if its text (or the files it would touch) match `rails.keywords` — reaching a person
  (send/email/message) or losing data (delete/destroy) — it is **set aside for your
  approval**, never built automatically;
- if its files fall under a `rails.territoryGlobs` folder, same thing.

This is deliberately over-cautious: a false "ask the human" costs you one glance; a false
"go ahead" could message someone or delete data. You can widen the rails per project.
**Deploying is NOT a rail** — it's the default outcome of a passing run (reversible: a bad
deploy rolls back). Opt out per run with `--no-land`, or per surface with `stageNotDeploy`.

## The learning stores

- **local** (`.thebashway/lessons.md`) — mistakes caught while building *this* repo, fed
  back into future runs so they aren't repeated. Written automatically.
- **global** (optional) — a shared file every project reads, so a lesson learned once is
  reused everywhere. Point `learning.global` at it (e.g. a central
  `operating-lessons.md`).

## How a run actually flows

1. **preflight** — make sure the branch is clean and pushed.
2. **claim** — take an item off the queue (`.thebashway/queue.md`).
3. **build** — a headless `claude` works the item on a fresh branch/worktree.
4. **verify** — run the surface's `chain` (your build/test) as evidence.
5. **integrate** — merge into a staging branch and re-verify.
6. **land** — merge to your main branch and deploy (the default; skipped only with
   `--no-land`, a `stageNotDeploy` surface, or an unbuilt/blocked member).
7. **learn** — record any mistake a gate caught into the local lessons.

A circuit breaker halts the loop if too many items fail in a row.
