// tools/orchestrator/verify/manifest.ts
import { createHash } from "node:crypto";
import type { CheckResult, VerifyManifest } from "./types";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function buildManifest(input: {
  surface: string;
  baseRef: string;
  head: string;
  territory: string[];
  diffText: string;
  outputText: string;
  checks: CheckResult[];
}): VerifyManifest {
  return {
    surface: input.surface,
    baseRef: input.baseRef,
    head: input.head,
    territory: input.territory,
    diffSha256: sha256(input.diffText),
    outputSha256: sha256(input.outputText),
    checks: input.checks,
    ok: input.checks.every((c) => c.ok),
    ts: new Date().toISOString(),
  };
}

/**
 * Driver-side integrity check (rule 1): recompute hashes from the REAL diff and
 * the captured output and confirm they match what verify claimed. The reviewing
 * agent never does this — the trusted driver does.
 */
export function verifyManifest(
  m: VerifyManifest,
  actualDiffText: string,
  actualOutputText: string,
): boolean {
  return (
    m.diffSha256 === sha256(actualDiffText) &&
    m.outputSha256 === sha256(actualOutputText)
  );
}
