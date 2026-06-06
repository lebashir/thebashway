// tools/orchestrator/manifest-check.ts
// The driver's integrity recompute (rule 1): given a verify manifest, recompute
// the diff hash from the REAL git diff between its recorded refs and confirm it
// matches what verify claimed. The reviewing agent never does this — the trusted
// driver does, BEFORE dispatching cold-review. (Output-hash recompute uses the
// captured chain output the driver holds at handoff; verifyManifest covers it.)
import { resolve } from "node:path";
import type { Runner } from "./verify/types";
import type { VerifyManifest } from "./verify/types";
import { bunRun, diffText } from "./verify/run";
import { sha256 } from "./verify/manifest";

export async function recheckManifest(
  manifestPath: string,
  repoRoot: string,
  run: Runner = bunRun,
): Promise<{ ok: boolean; reason?: string }> {
  const m = JSON.parse(await Bun.file(manifestPath).text()) as VerifyManifest;
  const actualDiff = await diffText(m.baseRef, m.head, repoRoot, run);
  if (sha256(actualDiff) !== m.diffSha256) {
    return {
      ok: false,
      reason: `diff hash mismatch — manifest (${m.diffSha256.slice(0, 12)}…) does not match the actual git diff of ${m.baseRef}..${m.head}`,
    };
  }
  return { ok: true };
}

if (import.meta.main) {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error("usage: bun run orchestrator/manifest-check.ts <manifestPath>");
    process.exit(2);
  }
  const repoRoot = resolve(import.meta.dir, "..", "..");
  const r = await recheckManifest(resolve(repoRoot, manifestPath), repoRoot);
  console.log(r.ok ? "manifest OK (diff hash matches git)" : `MANIFEST TAMPERED: ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}
