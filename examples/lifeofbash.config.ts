// examples/lifeofbash.config.ts
// The binding that reproduces lifeofbash's current behavior, expressed in the
// portable ProjectBinding shape. Doubles as the test fixture that proves the
// generalized engine behaves identically to the hardcoded original. Values are
// copied verbatim from the live tools/orchestrator/config.ts + required-touches.ts.

import { defineThebashway } from "../src/binding";

export const binding = defineThebashway({
  repoRoot: "/Users/bachir.habib/lifeofbash",
  defaultSurface: "tools",

  surfaces: {
    organs: {
      dir: "organs",
      role:
        "A secondary, deployed web-hub VIEW (lifeofbash.vercel.app). NOT the default home " +
        "for new features. Choose this surface ONLY when the feature is intrinsically a hub " +
        "UI view the user explicitly wants online — never as a fallback for work that has " +
        "no other home.",
      chain: [
        { name: "tsc", cmd: ["pnpm", "exec", "tsc", "--noEmit"] },
        { name: "lint", cmd: ["pnpm", "lint"] },
        { name: "test", cmd: ["pnpm", "test"] },
        { name: "build", cmd: ["pnpm", "build"] },
      ],
      derived: [
        "organs/src/generated/home-snapshot.json",
        "organs/src/generated/people-snapshot.json",
      ],
      regen: { name: "gen:home", cmd: ["pnpm", "gen:home"] },
      smoke: {
        cmd: ["pnpm", "exec", "tsx", "scripts/smoke-prod.ts"],
        portEnv: "SMOKE_PORT",
        needsBuild: true,
      },
      needsRealInstall: true,
      stageNotDeploy: true,
      requiredTouches: [
        {
          name: "organ-added-registry",
          whenStatus: ["A"],
          whenGlob: "organs/src/sections/*/index.ts",
          requireGlob: "organs/src/registry.ts",
          message: "added an organ (new sections/*/index.ts) but organs/src/registry.ts is unchanged",
        },
        {
          name: "organ-removed-registry",
          whenStatus: ["D"],
          whenGlob: "organs/src/sections/*/index.ts",
          requireGlob: "organs/src/registry.ts",
          message: "removed an organ (deleted sections/*/index.ts) but organs/src/registry.ts is unchanged",
        },
      ],
    },
    tools: {
      dir: "tools",
      role:
        "The substrate's executable layer — the DEFAULT home for new capabilities: " +
        "automations, MCP tools, jobs, scripts, the orchestrator. Most new features live " +
        "here. Ambiguous features default here, never to organs.",
      chain: [
        { name: "test", cmd: ["bun", "test"] },
        { name: "validate", cmd: ["bun", "run", "validate"] },
      ],
      derived: [],
      regen: null,
      smoke: null,
      // Tabby machine: bun fails TLS to external HTTPS without this.
      env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    },
  },

  auditTargets: {
    money: {
      surface: "organs",
      rootGlob: "organs/src/sections/money/**",
      subAreas: [
        "organs/src/sections/money/components/**",
        "organs/src/sections/money/read.ts",
        "organs/src/sections/money/actions.ts",
        "organs/src/sections/money/{forecast,parse,currency,period}.ts",
        "organs/src/sections/money/{schema,config,index}.ts",
      ],
    },
  },

  sweep: {
    scanGlobs: ["tools/**/*.ts"],
    excludeGlobs: [
      "**/node_modules/**",
      "**/.next/**",
      "**/__tests__/**",
      "**/*.test.ts",
      "**/*.d.ts",
      "**/generated/**",
    ],
    markerRegex: /\b(?:TODO|FIXME)\(tbw\)\s*:\s*(.*)$/,
    wrapUpGlobs: ["inbox/*-wrap-up-candidates.md"],
    wrapUpSignal:
      /\b(?:bug|fix(?:es|ed)?|broke[n]?|regress(?:ion)?|flaky|crash(?:es|ed)?|race condition|deadlock|leak|null|undefined|off-by-one|edge case|refactor|dedup|test(?:s|ing)?|lint|type ?error|typecheck|migration|endpoint|\bAPI\b|perf(?:ormance)?|cache|throttle|timeout|stale|smoke|verify gate)\b/i,
    maxPerSweep: 10,
    backlogWarnAt: 25,
  },

  rails: {
    territoryGlobs: ["tools/google/**", "tools/jobs/**"],
    keywords:
      /\b(?:send|sends|sending|sent|email|e-mail|emails|emailed|mail|message|messages|messaged|messaging|dm|dms|ping|pings|text|texts|texting|notify|notifies|notified|notifying|notification|nudge|nudges|nudging|remind|reminds|reminder|reminders|reach out|reaches out|sms|whatsapp|telegram|slack|broadcast|broadcasts|blast|blasts|alert|alerts|publish|published|tweet|tweets|post to|posts to|delete|deletes|deleting|deleted|drop|drops|dropping|dropped|truncate|truncates|truncated|destroy|destroys|destroying|destroyed|cancel|cancels|cancelling|canceling|cancelled|purge|purges|purged|wipe|wipes|wiped|erase|erases|erased|flush|flushes|remove all|removes all|removed all|clear all|reset the (?:db|database|table)|rm -rf)\b/i,
  },

  learning: {
    global: "/Users/bachir.habib/lifeofbash/memory/operating-lessons.md",
    local: "/Users/bachir.habib/lifeofbash/tools/orchestrator/lessons.md",
    decisions: "/Users/bachir.habib/lifeofbash/tools/orchestrator/decisions.md",
    brief: "tools/orchestrator/brief.ts",
  },
});

// Convenience re-export for the injection step (Task 1.2) + any consumer that
// wants the surface map directly.
export const SURFACES = binding.surfaces;
