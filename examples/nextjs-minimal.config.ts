// examples/nextjs-minimal.config.ts
// A second, deliberately-different binding — a generic single-surface Next.js app
// with NONE of lifeofbash's surface names. Used by the portability test to prove the
// engine runs against a binding it has never seen. This is what `thebashway init`
// would scaffold for a fresh repo (minus the real repoRoot).

import { defineThebashway } from "../src/binding";

export const binding = defineThebashway({
  repoRoot: "/tmp/nextjs-app",
  defaultSurface: "app",
  surfaces: {
    app: {
      dir: ".",
      role: "The application — the default and only home for features in this repo.",
      chain: [
        { name: "typecheck", cmd: ["pnpm", "exec", "tsc", "--noEmit"] },
        { name: "test", cmd: ["pnpm", "test"] },
        { name: "build", cmd: ["pnpm", "build"] },
      ],
    },
  },
  auditTargets: {
    core: { surface: "app", rootGlob: "src/**", subAreas: ["src/lib/**", "src/components/**"] },
  },
  rails: {
    territoryGlobs: ["src/server/email/**"],
    keywords: /\b(?:send|email|delete|deploy)\b/i,
  },
  learning: { global: null, local: ".thebashway/lessons.md", decisions: ".thebashway/decisions.md" },
});
