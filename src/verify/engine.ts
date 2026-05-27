// src/verify/engine.ts
// The verify engine — config-driven, project-agnostic. A project supplies its
// SURFACES + required-touches RULES and calls runVerify(); the package owns the
// gate logic. Emits per-check results + a tamper-evident manifest, returns the
// process exit code (0 ok / 1 fail / 2 bad usage).
import { resolve } from "node:path";
import type { CheckResult, SurfaceConfig } from "./types";
import { bunRun, changedFiles, changedWithStatus, diffText, gitHead } from "./run";
import { classifyChanges } from "./scope";
import { checkFreshness } from "./freshness";
import { runChain } from "./chain";
import { runSmoke } from "./smoke";
import { buildManifest } from "./manifest";
import { checkRequiredTouches, type TouchRule } from "../required-touches";

export interface VerifyOptions {
  /** The project's surfaces (e.g. { app: {...} }). */
  surfaces: Record<string, SurfaceConfig>;
  /** The project's required-touches rules (optional). */
  rules?: TouchRule[];
  /** process.argv.slice(2). */
  argv: string[];
  /** Absolute repo root — everything runs from here. */
  repoRoot: string;
  /** Where to write the manifest (default: <repoRoot>/.verify-manifest.json). */
  manifestPath?: string;
}

function parseArgs(argv: string[]) {
  const out = { surface: "", base: "HEAD", territory: [] as string[], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--surface") out.surface = argv[++i];
    else if (a === "--base") out.base = argv[++i];
    else if (a === "--territory") out.territory.push(argv[++i]);
    else if (a === "--json") out.json = true;
  }
  return out;
}

export async function runVerify(opts: VerifyOptions): Promise<number> {
  const args = parseArgs(opts.argv);
  const surface = opts.surfaces[args.surface];
  if (!surface) {
    console.error(`unknown surface "${args.surface}" — known: ${Object.keys(opts.surfaces).join(", ")}`);
    return 2;
  }
  process.chdir(opts.repoRoot);
  const head = await gitHead(opts.repoRoot);
  const checks: CheckResult[] = [];

  // 1. Scope-diff (only when a territory was declared).
  if (args.territory.length > 0) {
    const changed = await changedFiles(args.base, head, opts.repoRoot);
    const { outside } = classifyChanges(changed, args.territory);
    checks.push({
      name: "scope",
      ok: outside.length === 0,
      detail: outside.length ? `outside territory: ${outside.join(", ")}` : undefined,
    });
  }

  // 1b. Required-touches (completeness), when rules exist + a real base.
  if (opts.rules && opts.rules.length > 0 && args.base !== head) {
    const statusChanges = await changedWithStatus(args.base, head, opts.repoRoot);
    checks.push(...checkRequiredTouches(statusChanges, opts.rules));
  }

  // 2. Freshness (regen derived + git-diff).
  checks.push(await checkFreshness({ name: args.surface, ...surface }, bunRun));

  // 3. Gate chain.
  const chain = await runChain(surface.chain, surface, bunRun);
  checks.push(...chain.results);

  // 4. Smoke (in the surface dir, on a free port).
  const smoke = await runSmoke(surface.smoke, surface.dir, bunRun);
  checks.push(smoke);

  // Manifest — hashes the real diff + the captured chain output.
  const dt = await diffText(args.base, head, opts.repoRoot);
  const outputText = chain.output + `\n=== smoke ===\n${smoke.detail ?? ""}`;
  const manifest = buildManifest({
    surface: args.surface,
    baseRef: args.base,
    head,
    territory: args.territory,
    diffText: dt,
    outputText,
    checks,
  });

  const manifestPath = opts.manifestPath ?? resolve(opts.repoRoot, ".verify-manifest.json");
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  if (args.json) console.log(JSON.stringify(manifest, null, 2));
  else {
    for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
    console.log(`\n${manifest.ok ? "VERIFY PASSED" : "VERIFY FAILED"} (manifest: ${manifestPath})`);
  }
  return manifest.ok ? 0 : 1;
}
