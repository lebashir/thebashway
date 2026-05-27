#!/usr/bin/env bun
// tools/orchestrator/verify.ts  (PROJECT-SPECIFIC entry — copy + adapt the repoRoot depth)
// Thin wrapper: hand THIS project's config + rules to thebashway's engine.
//   bun run tools/orchestrator/verify.ts --surface app --base <ref> [--territory <glob> ...]
import { resolve } from "node:path";
import { runVerify } from "thebashway";
import { SURFACES } from "./config";
import { REQUIRED_TOUCHES } from "./required-touches";

// import.meta.dir = tools/orchestrator -> ".." = tools -> ".." = repo root.
// Adjust the depth if you place this file elsewhere.
const repoRoot = resolve(import.meta.dir, "..", "..");

process.exit(
  await runVerify({
    surfaces: SURFACES,
    rules: REQUIRED_TOUCHES,
    argv: process.argv.slice(2),
    repoRoot,
    manifestPath: resolve(import.meta.dir, ".verify-manifest.json"),
  }),
);
