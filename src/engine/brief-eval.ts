// src/engine/brief-eval.ts
// The per-CheckSpec termination ORACLE — a testable per-kind evaluator behind the
// injected Runner seam (the same seam runChain uses). This file is deliberately NOT
// part of the pure brief.ts: it does IO (the injected Runner, existsSync) and so must
// stay out of the writer-free, fs-free brief.ts (INV-A). It exports NO brief writer —
// it only EVALUATES whether a CheckSpec passes. See
// docs/specs/2026-06-07-north-star-design-brief.md (sections 3.2, 5.4 evaluateCheckSpec row, 8d).
//
// Only the real-process wiring (bunRun's kill-on-timeout) stays un-unit-tested; the
// DECISION logic here (exit-0 -> pass, non-zero -> fail, timeout -> fail, verify ->
// delegate to runChain, file-exists) is unit-tested with a FAKE Runner.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CheckSpec } from "./brief";
import type { Check, Runner } from "./verify/types";
import { runChain } from "./verify/chain";

/** What each CheckSpec kind needs to evaluate, injected so tests control IO. */
export interface EvalCtx {
  /** Pinned working directory for `command` checks (spec: cwd: repoRoot). */
  repoRoot: string;
  /** The injected process runner (real impl shells out; tests pass a fake). */
  run: Runner;
  /** The surface a `verify` check delegates to — its gate-chain is run via runChain. */
  surface?: { dir: string; env?: Record<string, string>; chain: Check[] };
  /** Overridable existence probe for `file-exists` (default node:fs existsSync). */
  exists?: (path: string) => boolean;
}

/** Default per-CheckSpec command timeout (spec 3.2: timeoutMs default 60s). */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Evaluate a single success-criterion CheckSpec to a pass/fail verdict.
 *
 * - 'command'     -> run `spec.run` as a shell string under repoRoot, enforcing the
 *                    per-CheckSpec `timeoutMs` (default 60s). pass = (exit === expectExit).
 *                    A TIMEOUT counts as FAIL, never pass (bunRun resolves a timeout to a
 *                    non-zero exit that cannot equal a 0 expectExit; this evaluator also
 *                    treats any explicit timeout sentinel as fail).
 * - 'verify'      -> delegate to runChain(surface.chain, surface, run); pass = chain.ok.
 * - 'file-exists' -> pass = exists(resolve(repoRoot, spec.path)).
 */
export async function evaluateCheckSpec(spec: CheckSpec, ctx: EvalCtx): Promise<{ pass: boolean }> {
  switch (spec.kind) {
    case "command": {
      const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      // spec.run is a shell string (it may use shell operators like `&&`); run it through
      // a shell so those semantics hold, pinning cwd to repoRoot per the spec.
      const r = await ctx.run(["bash", "-lc", spec.run], { cwd: ctx.repoRoot, timeoutMs });
      // A timeout is a FAILURE, never a pass — even if expectExit were coincidentally set
      // to the timeout sentinel, a timed-out run cannot count as the criterion being met.
      if (r.timedOut === true) return { pass: false };
      return { pass: r.code === spec.expectExit };
    }
    case "verify": {
      if (!ctx.surface) {
        // No surface to delegate to => the verify criterion cannot be confirmed met.
        return { pass: false };
      }
      const chain = await runChain(ctx.surface.chain, ctx.surface, ctx.run);
      return { pass: chain.ok };
    }
    case "file-exists": {
      const probe = ctx.exists ?? existsSync;
      return { pass: probe(resolve(ctx.repoRoot, spec.path)) };
    }
  }
}
