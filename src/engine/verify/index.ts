// src/engine/verify/index.ts
// runVerify(): the binding-aware verify gate. Assembles the per-surface checks (scope-diff,
// required-touches, freshness, gate chain, smoke), writes a manifest, and returns it. repoRoot,
// the manifest path, and the surface all come from the loaded binding (passed by the CLI `verify`
// verb) — never hardcoded. SURFACES is the in-place binding-injected map (config.setBinding), so a
// consumer's surfaces + per-surface requiredTouches are read here without threading a binding param.
import { resolve } from "node:path";
import { SURFACES } from "../config";
import type { CheckResult, VerifyManifest } from "./types";
import { bunRun, changedFiles, changedWithStatus, diffText, gitHead } from "./run";
import { classifyChanges } from "./scope";
import { checkRequiredTouches, type TouchRule } from "../required-touches";
import { checkFreshness } from "./freshness";
import { runChain } from "./chain";
import { runSmoke } from "./smoke";
import { buildManifest } from "./manifest";

export interface RunVerifyOpts {
  surface: string;
  /** The target repo root (binding.repoRoot). Everything runs from here. */
  repoRoot: string;
  /** Where to write the manifest (absolute or repoRoot-relative). */
  manifestPath: string;
  base?: string;
  territory?: string[];
  /** Required-touch rules. Defaults to those declared across the (binding-injected) surfaces. */
  rules?: TouchRule[];
  /** Emit per-check lines + a PASS/FAIL summary to stdout. */
  log?: boolean;
}

export interface RunVerifyResult {
  manifest: VerifyManifest;
  manifestPath: string;
}

/** Gather the required-touch rules declared across all (binding-injected) surfaces. They are
 *  glob-gated, so running every surface's rules on any verify is harmless — a rule only fires when
 *  its trigger glob matches a changed path. */
function rulesFromSurfaces(): TouchRule[] {
  return Object.values(SURFACES).flatMap((s) => s.requiredTouches ?? []);
}

export async function runVerify(opts: RunVerifyOpts): Promise<RunVerifyResult> {
  const { surface: surfaceName, repoRoot, log = false } = opts;
  const base = opts.base ?? "HEAD";
  const territory = opts.territory ?? [];
  const surface = SURFACES[surfaceName];
  if (!surface) {
    throw new Error(`unknown surface "${surfaceName}" — known: ${Object.keys(SURFACES).join(", ")}`);
  }
  const manifestPath = resolve(repoRoot, opts.manifestPath);
  // Run everything from the repo root so relative surface dirs ("organs", "tools") and the
  // freshness git pathspecs resolve correctly even when verify is invoked from a subdir.
  process.chdir(repoRoot);
  const head = await gitHead(repoRoot);
  const checks: CheckResult[] = [];

  // 1. Scope-diff (only when a territory was declared).
  if (territory.length > 0) {
    const changed = await changedFiles(base, head, repoRoot);
    const { outside } = classifyChanges(changed, territory);
    checks.push({
      name: "scope",
      ok: outside.length === 0,
      detail: outside.length ? `outside territory: ${outside.join(", ")}` : undefined,
    });
  }

  // 1b. Required-touches (completeness — the "touched too little" guard), from the binding.
  // Only meaningful when comparing against a real base (not HEAD..HEAD).
  if (base !== head) {
    const statusChanges = await changedWithStatus(base, head, repoRoot);
    checks.push(...checkRequiredTouches(statusChanges, opts.rules ?? rulesFromSurfaces()));
  }

  // 2. Freshness (regen derived + git-diff).
  checks.push(await checkFreshness({ name: surfaceName, ...surface }, bunRun));

  // 3. Gate chain (tsc/lint/test/build per surface).
  const chain = await runChain(surface.chain, surface, bunRun);
  checks.push(...chain.results);

  // 4. Smoke (runs in the surface's declared dir).
  const smoke = await runSmoke(surface.smoke, surface.dir, bunRun);
  checks.push(smoke);

  // Manifest — hashes the real diff + the captured chain output.
  const dt = await diffText(base, head, repoRoot);
  const outputText = chain.output + `\n=== smoke ===\n${smoke.detail ?? ""}`;
  const manifest = buildManifest({
    surface: surfaceName,
    baseRef: base,
    head,
    territory,
    diffText: dt,
    outputText,
    checks,
  });

  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  if (log) {
    for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
    console.log(`\n${manifest.ok ? "VERIFY PASSED" : "VERIFY FAILED"} (manifest: ${manifestPath})`);
  }
  return { manifest, manifestPath };
}
