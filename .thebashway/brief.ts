// .thebashway/brief.ts — the per-project DESIGN BRIEF (north star).
// Written by `thebashway brief write` from the agent interview. A TS module that
// `export default`s a zod-validated object — edit freely, keep it loadable.
export default {
  "confirmed": true,
  "narrative": "A helper that lets Claude build and fix code in your project on its own — safely. You give it a one-line request; it does the work on a side branch, checks its own work, and only keeps changes that pass.",
  "purpose": "A portable, autonomous build loop: it lets Claude build and fix code in any repo on its own — behind evidence-backed verify gates, with human-approval rails for anything irreversible.",
  "whyNow": "Trustworthy, low-supervision builds: hand off well-scoped work to an agent that checks its own work, without unattended-autonomy risk — every change is gated on the repo's real build/tests, and irreversible or person-reaching actions always stop for a human.",
  "whoServed": "Developers who want to delegate well-scoped build/fix work to an autonomous agent, and the agent itself driving larger multi-wave builds in-session. Consumed by any repo via a binding + the Claude Code plugin; lifeofbash was the first consumer.",
  "scope": "The build loop and its gates: the IN door (Fix audits a target into items; Build designs + decomposes a feature), the OUT door (drain: build on a branch -> verify against the repo's own chain -> integrate only if green -> land), the safety rails, the learning loops, and the north-star brief — all as a portable Bun/TS engine + CLI injected with one per-project binding.",
  "limits": "Never re-couple to one consumer's layout (it was extracted from lifeofbash precisely to be portable — no hardcoded paths or assumptions). Never auto-perform irreversible or person-reaching actions without human approval (the rails are non-negotiable). Never claim done without evidence — a green gate, not trust.",
  "inScopeSurfaces": [
    "engine"
  ],
  "forbiddenSurfaces": [],
  "forbiddenTerritory": [],
  "timeHorizon": "",
  "target": "",
  "openExplorations": [],
  "conventions": [
    "Package manager: Bun. Tests: `bun test`; typecheck: `bun run typecheck` (tsc over src, node-independent via `bun --bun x tsc`).",
    "Evidence before assertions — every gate is evidence the next stage rechecks; never claim done on trust.",
    "TDD for engine changes: a failing test first, then the minimal code to pass.",
    "Portable by construction: everything project-specific arrives through the injected ProjectBinding; no hardcoded consumer paths in the engine.",
    "The brief is human-gated (INV-A): the engine never writes it; updates are proposed for a human to apply.",
    "No emojis in committed docs; ISO 8601 dates."
  ],
  "glossary": [
    {
      "term": "basha",
      "means": "a dispatched headless worker agent that builds or reviews one task"
    },
    {
      "term": "drain",
      "means": "the OUT-door loop: claim a queue item, build it on a branch, verify, integrate if green, then land"
    },
    {
      "term": "binding",
      "means": "the one thebashway.config.ts a repo supplies to teach the engine its surfaces, rails, learning stores, and paths"
    },
    {
      "term": "rails",
      "means": "the human-approval gate: irreversible or person-reaching work is set aside, never auto-built"
    },
    {
      "term": "brief",
      "means": "this north star — the per-project living definition the loop reads and run-to-goal drives toward"
    },
    {
      "term": "surface",
      "means": "a buildable area of the repo with its own verify chain (this repo has one: engine)"
    }
  ],
  "gaps": [],
  "successCriteria": [
    {
      "id": "verify",
      "statement": "the engine's verify chain (typecheck over src + the full test suite) passes",
      "check": {
        "kind": "verify"
      },
      "required": true
    },
    {
      "id": "tests-typed",
      "statement": "the whole repo type-checks with tests included (full type coverage, no noUncheckedIndexedAccess gaps)",
      "check": {
        "kind": "command",
        "run": "bun run typecheck:all",
        "expectExit": 0,
        "timeoutMs": 60000
      },
      "required": true
    },
    {
      "id": "tests-pass",
      "statement": "the test suite passes",
      "check": {
        "kind": "command",
        "run": "bun test",
        "expectExit": 0,
        "timeoutMs": 60000
      },
      "required": true
    }
  ],
  "milestones": [
    {
      "statement": "the headless loop builds or fixes a real item end-to-end on a real repo, keeping only changes that pass the verify gate",
      "humanJudged": true
    }
  ]
};
