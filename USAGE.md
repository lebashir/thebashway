# thebashway — usage

Day-to-day use, the helper API, and the safety rails. For wiring a new project see
`template/README.md`; for the philosophy + the loop see `README.md`.

## Running the gate

```bash
# Full gate for a surface, scoped to a unit's territory, vs a base ref:
bun run tools/orchestrator/verify.ts \
  --surface app \
  --base origin/main \
  --territory "app/src/sections/settings/**" \
  --territory "app/src/registry.ts"

# Flags:
#   --surface <name>     which surface from config.ts (required)
#   --base <ref>         git ref to diff against (default HEAD)
#   --territory <glob>   allowed files (repeatable); omit to skip scope-diff
#   --json               print the manifest as JSON
# Exit code: 0 = pass, 1 = fail, 2 = bad usage. A manifest is written to
# .verify-manifest.json (gitignored).
```

`verify` runs scope-diff → required-touches → freshness → gate-chain → smoke, and
emits a tamper-evident manifest (diff hash + output hash + territory).

## The loop, run by a session

A session invokes the `thebashway` skill and works one queue item at a time.
(The dispatched workers are **bashas**: a single *basha*; specialized ones are
*building / planning / thinking / designing / reviewing* bashas.)

1. **Intake** — clarify the item's *shape* with the human at add-time; write a
   self-contained entry to `queue.md`.
2. **Claim** — `claimNext(session, branch, queuePath)` (lock-guarded).
3. **Spec + cold review** — a reviewing basha, spec as its only input.
4. **Slice + build** — building bashas; disjoint territories, isolated worktrees, ≤3–4 parallel.
5. **`verify`** each chunk; keep the manifest.
6. **Diff review** — a reviewing basha, diff + spec as input; requires the manifest.
7. **Integrate** — serial merges, re-verify after each.
8. **Deploy + smoke** — auto-roll-back on failure; `markBlocked` with the reason.
9. **Cleanup** — `assertClean(branchPattern)` after worktree teardown.
10. **Digest** — `appendDigest(log, record)` + `summaryLine(record)` to NOW.

## Helper API (import from `thebashway`)

```ts
import {
  runVerify,                    // the gate engine (config-driven)
  recheckManifest,              // driver recomputes the diff hash vs git (trust check)
  withLock,                     // exclusive-create lockfile mutex (multi-session)
  claimNext, markBlocked, markDone, appendItem,  // queue ops (lock-guarded)
  parseQueue, serializeItem,    // queue.md <-> QueueItem
  assertClean,                  // leave-no-trace assertion
  shouldTrip, overBudget,       // circuit breaker + runaway budget
  formatRecord, summaryLine, appendDigest,        // run digest
  classifyChanges, checkRequiredTouches, checkFreshness, freePort, // gate pieces
} from "thebashway";
```

- `recheckManifest(manifestPath, repoRoot)` — the integrity check the **driver**
  runs before cold-review (the reviewer never self-validates).
- `shouldTrip(recentOutcomes, maxFailures, window)` — sliding-window circuit
  breaker (not "N consecutive").
- `overBudget(used, limit)` — per-item runaway guard.

## Safety rails (never autonomous)

The loop may build, deploy, roll back, redeploy, run schema changes. It will NOT,
without a human: (a) destroy unrecoverable data, (b) send anything that reaches
other people, or (c) deploy a change to a surface smoke cannot exercise
(background jobs, webhooks) until smoke covers it.

## Tuning (per project)

- circuit-breaker window: `shouldTrip(recent, X, Y)` — pick X failures in last Y.
- runaway budget: turns / tool-calls / wall-clock per item.
- concurrency cap: ~3–4 parallel units.
- smoke port range: ephemeral by default (`freePort`).

## Tests

```bash
bun test        # the generic engine + helper suite
```
