// thebashway.config.ts — thebashway building itself (dogfood).
//
// Hand-authored (NOT `thebashway init`-generated): the init template imports from the
// "thebashway" package name, which does not resolve INSIDE the engine repo, so this uses
// a relative import like the examples/. One `engine` surface over the Bun/TS source.
//
// Verify chain is `[test]` only — `bun test` is the green gate. Standalone
// `tsc --noEmit` is deliberately NOT in the chain: the repo runs on Bun's transpile-time
// checking and does not install `@types/bun`, so `bunx tsc` fails on TS2688 (missing bun
// types), not on real errors. Run `bunx tsc --noEmit` by hand if you want a typecheck pass.
//
// Learning stores point at the repo's REAL, accumulated Loop A/B files (src/engine/*.md),
// so a build here dogfoods the live learning loop rather than empty `.thebashway/` seeds.

import { defineThebashway } from "./src/binding";

export default defineThebashway({
  repoRoot: import.meta.dir,
  defaultSurface: "engine",
  surfaces: {
    engine: {
      dir: ".",
      role: "The thebashway engine itself — the portable Bun/TS build-loop library and CLI under src/**. The default and only home for features in this repo.",
      chain: [
        { name: "test", cmd: ["bun", "run", "test"] },
      ],
    },
  },
  rails: {
    // A task whose text or changed files match these is set aside for human approval. This
    // repo has no people-reaching/data-destroying surface, so this is a conservative guard,
    // not a deploy gate (deploy/publish are NOT rails — see the deploy-by-default doctrine).
    territoryGlobs: [],
    keywords: /\b(?:send|email|sms|message|delete|destroy|drop|purge|wipe)\b/i,
    // the engine builds itself headlessly; the brief gate is opt-out here (no human interview mid-self-build).
    requireBrief: false,
  },
  learning: {
    global: null,
    local: "src/engine/lessons.md",
    decisions: "src/engine/decisions.md",
  },
});
