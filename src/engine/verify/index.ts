// tools/orchestrator/verify/index.ts
// CLI: bun run orchestrator/verify/index.ts --surface organs --base <ref> \
//        [--territory "organs/src/sections/money/**" ...] [--json]
// Emits a manifest to tools/orchestrator/.verify-manifest.json and exits 0/1.
import { resolve } from "node:path";
import { SURFACES } from "../config";
import type { CheckResult } from "./types";
import { bunRun, changedFiles, changedWithStatus, diffText, gitHead } from "./run";
import { classifyChanges } from "./scope";
import { checkRequiredTouches } from "../required-touches";
import { checkFreshness } from "./freshness";
import { runChain } from "./chain";
import { runSmoke } from "./smoke";
import { buildManifest } from "./manifest";

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const surface = SURFACES[args.surface];
  if (!surface) {
    console.error(`unknown surface "${args.surface}" — known: ${Object.keys(SURFACES).join(", ")}`);
    process.exit(2);
  }
  const repoRoot = resolve(import.meta.dir, "..", "..", "..");
  // Run everything from the repo root so relative surface dirs ("organs",
  // "tools") and the freshness git pathspecs resolve correctly even when verify
  // is invoked from tools/.
  process.chdir(repoRoot);
  const head = await gitHead(repoRoot);
  const checks: CheckResult[] = [];

  // 1. Scope-diff (only when a territory was declared).
  if (args.territory.length > 0) {
    const changed = await changedFiles(args.base, head, repoRoot);
    const { outside } = classifyChanges(changed, args.territory);
    checks.push({
      name: "scope",
      ok: outside.length === 0,
      detail: outside.length ? `outside territory: ${outside.join(", ")}` : undefined,
    });
  }

  // 1b. Required-touches (completeness — the "touched too little" guard).
  // Only meaningful when comparing against a real base (not HEAD..HEAD).
  if (args.base !== head) {
    const statusChanges = await changedWithStatus(args.base, head, repoRoot);
    checks.push(...checkRequiredTouches(statusChanges));
  }

  // 2. Freshness (regen derived + git-diff).
  checks.push(await checkFreshness({ name: args.surface, ...surface }, bunRun));

  // 3. Gate chain (tsc/lint/test/build per surface).
  const chain = await runChain(surface.chain, surface, bunRun);
  checks.push(...chain.results);

  // 4. Smoke (runs in the surface's declared dir).
  const smoke = await runSmoke(surface.smoke, surface.dir, bunRun);
  checks.push(smoke);

  // Manifest — hashes the real diff + the captured chain output.
  const dt = await diffText(args.base, head, repoRoot);
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

  const manifestPath = resolve(repoRoot, "tools/orchestrator/.verify-manifest.json");
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  if (args.json) console.log(JSON.stringify(manifest, null, 2));
  else {
    for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
    console.log(`\n${manifest.ok ? "VERIFY PASSED" : "VERIFY FAILED"} (manifest: ${manifestPath})`);
  }
  process.exit(manifest.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("verify error:", err);
  process.exit(1);
});
