// tools/orchestrator/config.ts  (PROJECT-SPECIFIC — copy this template + adapt)
// The only project-specific binding for verify: your surfaces and their gate
// commands. A "surface" is a buildable/testable area (an app, a package, a CLI).
import type { SurfaceConfig } from "thebashway";

/**
 * Run-mode budget: the maximum number of in-flight bashas across ALL queue
 * items + within-item slices. The autonomous run loop allocates this budget
 * FIFO. Tune per machine + per LLM-rate-limit; 4 is a sane default.
 */
export const MAX_CONCURRENT_BASHAS = 4;

/** Glob for orphan-branch cleanup. Bashas branch under this prefix. */
export const DEFAULT_BRANCH_PATTERN = "tbw/*";

export const SURFACES: Record<string, SurfaceConfig> = {
  // Example: a Next.js-style app surface.
  app: {
    dir: "app", // repo-root-relative dir the surface lives in
    chain: [
      { name: "tsc", cmd: ["pnpm", "exec", "tsc", "--noEmit"] },
      { name: "lint", cmd: ["pnpm", "lint"] },
      { name: "test", cmd: ["pnpm", "test"] },
      // Use the command that fires any prebuild/codegen — NOT a step-skipping shortcut.
      { name: "build", cmd: ["pnpm", "build"] },
    ],
    // Committed generated files to assert fresh (regenerate -> git diff must be empty).
    derived: [], // e.g. ["app/src/generated/snapshot.json"]
    regen: null, // e.g. { name: "gen", cmd: ["pnpm", "gen"] }
    // Smoke: a script that boots the built app on $SMOKE_PORT and GETs routes,
    // asserting status + a positive marker. null if the surface has no server.
    smoke: null, // e.g. { cmd: ["pnpm","exec","tsx","scripts/smoke.ts"], portEnv: "SMOKE_PORT", needsBuild: true }
  },

  // Example: a Bun tools/scripts surface (no build, no smoke).
  tools: {
    dir: "tools",
    chain: [{ name: "test", cmd: ["bun", "test"] }],
    derived: [],
    regen: null,
    smoke: null,
    // Per-surface env (e.g. a TLS workaround on a specific machine):
    // env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
  },
};
