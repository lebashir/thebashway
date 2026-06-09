// src/engine/autonomous.ts
// The NAMED re-invoking driver behind "run until the goal is met" (spec 5.4) — now PART-OR-ALL
// aware. A single `drain` is hard-bounded by `n` and `if (!item) break`, so it can only stop
// SOONER, never run UNTIL done; `runToGoal` is the loop that re-invokes drain until the brief's
// target slice (or the whole required set) is met — under REQUIRED caps.
//
// INV-A (spec 1.1, 5.4 "must NOT relax"): this file imports NO brief writer. It only loadBrifs
// and EVALUATES. Any milestone-reflection brief update routes through emitPark/sinks — never
// writeFileSync(briefPath). The PRIMITIVES it composes are tested in isolation: goalMet
// (breaker.ts, empty-set => false) and evaluateCheckSpec (brief-eval.ts).
//
// COST/RUNAWAY (memory bashir-cost-sensitive): the caps below are REQUIRED, not optional —
// maxIterations (default 5), maxWallClockMs (via the injected now()), an overBudget cost ceiling,
// and a no-progress K=2 stall detector DISTINCT from the failure breaker.
import type { CheckSpec } from "./brief";
import type { LoadBriefResult } from "./load-brief";
import type { DrainOptions, DrainReport } from "./drain";
import type { AuditOptions, AuditReport } from "./audit-run";
import type { EvalCtx } from "./brief-eval";
import { goalMet, overBudget } from "./breaker";

// ---------------------------------------------------------------------------
// Public types (spec 5.4 signature block — verbatim contract)
// ---------------------------------------------------------------------------

export interface RunToGoalOptions {
  surface: string;
  queuePath: string;
  repoRoot: string;
  briefPath: string;
  /** PART-OR-ALL TARGETING (spec 5.4). A subset of the brief's successCriteria ids to drive
   *  toward. DEFAULT (undefined) = ALL required ids. Validated against real criterion ids (an
   *  unknown id is a typed terminal reason, never a silent drop); reduced over by `goalMet`;
   *  never lets an unconfirmed brief terminate; a resolved target with zero REQUIRED criteria
   *  refuses to report success. */
  targetCriteria?: string[];
  // --- runaway guards (REQUIRED, unchanged) ---
  maxIterations?: number; // default 5
  maxWallClockMs?: number;
  costCeiling?: number; // compared via overBudget()
  // --- drain pass-through ---
  drainOpts?: Partial<DrainOptions>; // n, breaker, land, landBranch, …
}

export type RunToGoalReason =
  | "already-satisfied"
  | "goal-fully-met" // target == ALL required AND every required criterion passes
  | "target-slice-met" // a strict subset / a target containing required:false ids met (NOT the whole star)
  | "machine-criteria-met-pending-human" // milestones present → stop-and-ask (never claim full success)
  | "cap-hit"
  | "breaker-tripped"
  | "no-progress"
  | "queue-empty-goal-unmet"
  | "brief-unconfirmed" // count-bounded fallback engaged (spec 4.2)
  | "invalid-target" // unknown targetCriteria id — refuse-to-run, typed, not a throw
  | "target-has-no-required-criterion"; // resolved target contains zero required criteria — refuse success

export interface RunToGoalResult {
  goalMet: boolean;
  iterations: number;
  reason: RunToGoalReason;
  built: number;
  /** The RESOLVED target ids actually driven toward (all-required when targetCriteria omitted). */
  target: string[];
  /** Required criteria still failing at stop (drives the honest notify line). */
  failingRequired: string[];
}

/** The default cap values (spec 5.4 + memory bashir-cost-sensitive). */
export const DEFAULT_MAX_ITERATIONS = 5;
/** No-progress stall stop (spec 5.4): K consecutive green-but-unmoving iterations => stop. */
export const NO_PROGRESS_STALL_LIMIT = 2;

export interface RunToGoalDeps {
  /** Load+validate the brief (spec 3.1 contract). */
  loadBrief(briefPath: string): Promise<LoadBriefResult>;
  /** Evaluate ONE success-criterion CheckSpec to pass/fail (brief-eval.ts; the EvalCtx is supplied
   * by the caller's wiring — here we only need the surface/run plumbing it carries). */
  evaluateCheckSpec(spec: CheckSpec, ctx: EvalCtx): Promise<{ pass: boolean }>;
  /** The EvalCtx the evaluator runs under (repoRoot, run, surface chain). Injected so the driver
   * itself stays free of process/fs wiring. */
  evalCtx: EvalCtx;
  /** Run ONE drain pass (re-invoked each iteration). */
  runDrain(opts: DrainOptions): Promise<DrainReport>;
  /** The work-bridge: ONE targeted audit pass at the failing target criteria's surface(s). */
  runAudit(opts: AuditOptions): Promise<AuditReport>;
  /** Human notifier (Telegram/event sink). */
  notify(text: string): Promise<void> | void;
  /** Park a brief-update / stop-and-ask for the human (spec 4.3 human-gate). */
  emitPark(title: string, reason: string): Promise<void>;
  /** Injectable wall-clock. Default Date.now in the real wiring; tests control time. */
  now(): number;
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

export async function runToGoal(opts: RunToGoalOptions, deps: RunToGoalDeps): Promise<RunToGoalResult> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const startedAt = deps.now();

  // ---- 1. Load the brief (spec 5.4 point 1) ----
  const loaded = await deps.loadBrief(opts.briefPath);

  // status:'unparseable' => loud signal, NO run (the §3.1 parse-failure contract).
  if (loaded.status === "unparseable") {
    const reason = `brief unparseable — north star not loaded; autonomous-to-goal will not run: ${loaded.errors.join("; ")}`;
    await deps.emitPark("brief unparseable — north star not loaded", reason);
    await deps.notify(reason);
    return { goalMet: false, iterations: 0, reason: "brief-unconfirmed", built: 0, target: [], failingRequired: [] };
  }

  // status:'absent' => no goal function; degrade to count-bounded with brief-unconfirmed-class
  // messaging. We still bound a single drain (count-bounded) so the caller isn't silently a no-op.
  if (loaded.status === "absent" || !loaded.brief) {
    await deps.notify("no brief — autonomous-to-goal disabled (count-bounded fallback only).");
    const built = await runOneCountBoundedDrain(opts, deps);
    return { goalMet: false, iterations: 1, reason: "brief-unconfirmed", built, target: [], failingRequired: [] };
  }

  const brief = loaded.brief;

  // ---- 2. confirmed:true is load-bearing and OUTRANKS targeting (spec 5.4 point 2) ----
  if (!brief.confirmed) {
    await deps.notify("brief unconfirmed; autonomous-to-goal disabled until confirmed.");
    const built = await runOneCountBoundedDrain(opts, deps);
    return { goalMet: false, iterations: 1, reason: "brief-unconfirmed", built, target: [], failingRequired: [] };
  }

  // ---- 3. Validate targetCriteria against REAL ids (spec 5.4 point 3) ----
  const allIds = new Set(brief.successCriteria.map((c) => c.id));
  const requiredIds = brief.successCriteria.filter((c) => c.required).map((c) => c.id);
  const requiredSet = new Set(requiredIds);

  if (opts.targetCriteria) {
    const unknown = opts.targetCriteria.filter((id) => !allIds.has(id));
    if (unknown.length) {
      // Unknown id => typed terminal reason, NOT a throw — the unattended path degrades safely.
      await deps.notify(`invalid target: unknown success-criterion id(s) [${unknown.join(", ")}] — refusing to run-to-goal.`);
      return { goalMet: false, iterations: 0, reason: "invalid-target", built: 0, target: [], failingRequired: [] };
    }
  }

  // Resolve the effective target (spec 5.4 point 3).
  const target = opts.targetCriteria ? [...opts.targetCriteria] : [...requiredIds];
  const targetSet = new Set(target);
  const targetIsAllRequired = isAllRequired(targetSet, requiredSet);

  // ---- 4. Two coverage guards (spec 5.4 point 4) ----
  // Empty resolved target => refuse to run (goalMet would be false forever; do NOT spin).
  if (targetSet.size === 0) {
    await deps.notify("nothing to drive toward (empty target) — refusing to run-to-goal.");
    return { goalMet: false, iterations: 0, reason: "target-has-no-required-criterion", built: 0, target, failingRequired: [] };
  }
  // Zero-REQUIRED-criterion target => refuse success (the empty-set guard does NOT catch this:
  // a non-empty target of only required:false ids would let goalMet return a false win).
  const targetHasRequired = target.some((id) => requiredSet.has(id));
  if (!targetHasRequired) {
    await deps.notify(
      "target contains zero required criteria — refusing to report success (a non-required slice can never satisfy the north star).",
    );
    return { goalMet: false, iterations: 0, reason: "target-has-no-required-criterion", built: 0, target, failingRequired: [] };
  }

  // ---- 5. Milestone precedence (spec 5.4 point 6) — milestone OUTRANKS target-met ----
  // ANY milestones-bearing brief => stop-and-ask, regardless of target. Never goal-fully-met /
  // target-slice-met from the machine alone. Rate-limited (one park per brief; the seam itself
  // owns the rate-limit, here we park at most once before any drain spins).
  const hasMilestones = brief.milestones.length > 0;

  // Evaluate the target's passing-membership.
  const evalTarget = async (): Promise<{ passing: Set<string>; failingRequired: string[] }> => {
    const checked: Record<string, boolean> = {};
    for (const id of targetSet) {
      const c = brief.successCriteria.find((x) => x.id === id);
      if (!c) {
        checked[id] = false;
        continue;
      }
      const { pass } = await deps.evaluateCheckSpec(c.check, deps.evalCtx);
      checked[id] = pass;
    }
    const passing = new Set([...targetSet].filter((id) => checked[id] === true));
    const failingRequired = requiredIds.filter((id) => targetSet.has(id) && checked[id] !== true);
    return { passing, failingRequired };
  };

  // ---- 6. Loop: evaluate at TOP, then drain → re-evaluate → repeat (spec 5.4) ----
  let built = 0;
  // `spent` is the cumulative number of build bashas spawned across the run (every CLAIMED item
  // spawns a headless build basha = the real LLM-spend driver). It is the costCeiling axis —
  // DISTINCT from `iterations`: a few productive drains can spawn many bashas, so the cost rail
  // can bite before maxIterations does. (memory bashir-cost-sensitive)
  let spent = 0;
  let iterations = 0;
  let stall = 0;
  let prevPassingKey: string | null = null;
  let lastFailingRequired: string[] = [];
  // For the unsatisfiable-target flag: track whether failingRequired stayed CONSTANT all run.
  let constantFailingRequired: string[] | null = null;
  let failingEverChanged = false;

  // Initial top-of-loop evaluation (entry check).
  let { passing, failingRequired } = await evalTarget();
  lastFailingRequired = failingRequired;
  constantFailingRequired = failingRequired;

  const decideMet = (): RunToGoalResult => {
    // Milestone precedence: a milestone-bearing brief NEVER claims success from the machine.
    if (hasMilestones) {
      // park (rate-limited by the seam) + stop-and-ask.
      void deps.emitPark(
        "machine criteria met — human milestone judgment pending",
        "the targeted machine success-criteria pass, but this brief carries human-judged milestone(s); autonomous-to-goal must not declare done.",
      );
      void deps.notify("machine criteria met; pending human milestone judgment (parked).");
      return {
        goalMet: false,
        iterations,
        reason: "machine-criteria-met-pending-human",
        built,
        target,
        failingRequired,
      };
    }
    // Honest success terminal (spec 5.4 point 5).
    if (targetIsAllRequired) {
      return { goalMet: true, iterations, reason: "goal-fully-met", built, target, failingRequired: [] };
    }
    // A slice (strict subset OR a target with required:false ids): target-slice-met, enumerating
    // the still-failing REQUIRED criteria so the slice win is honest about being a slice.
    const stillFailing = requiredIds.filter((id) => !passing.has(id));
    void deps.notify(
      `target slice met. Still-failing required criteria: [${stillFailing.join(", ") || "none"}].`,
    );
    return { goalMet: true, iterations, reason: "target-slice-met", built, target, failingRequired: stillFailing };
  };

  // Entry check: if the target is already met (even if untargeted criteria fail), short-circuit.
  if (goalMet(setToRecord(passing, targetSet), targetSet)) {
    // Milestone precedence still applies: a milestone brief that is already met parks
    // (machine-criteria-met-pending-human) rather than claims done.
    if (hasMilestones) return decideMet(); // iterations=0, built=0 here
    // already-satisfied (NOT goal-fully-met) — built:0, no drain spun.
    return { goalMet: true, iterations: 0, reason: "already-satisfied", built: 0, target, failingRequired: [] };
  }

  while (iterations < maxIterations) {
    // Cap: wall-clock (checked BEFORE spinning another drain).
    if (opts.maxWallClockMs !== undefined && overBudget(deps.now() - startedAt, opts.maxWallClockMs)) {
      return capHit(iterations, built, target, lastFailingRequired, constantFailingRequired, !failingEverChanged, deps);
    }
    // Cap: cumulative cost = build bashas spawned so far (a real axis distinct from iterations).
    if (opts.costCeiling !== undefined && overBudget(spent, opts.costCeiling)) {
      return capHit(iterations, built, target, lastFailingRequired, constantFailingRequired, !failingEverChanged, deps);
    }

    iterations++;

    // Run ONE drain pass, threading the early-stop seam + target.
    const report = await deps.runDrain(buildDrainOpts(opts, target));
    built += report.succeeded.length;
    spent += report.claimed.length; // every claimed item spawned a build basha — the cost axis

    if (report.breakerTripped) {
      await deps.notify("autonomous-to-goal halted: drain breaker tripped.");
      return { goalMet: false, iterations, reason: "breaker-tripped", built, target, failingRequired: lastFailingRequired };
    }

    // Work-bridge (spec 5.4 point 7): the queue emptied with the target unmet => run ONE targeted
    // audit pass at the failing target criteria's surface; if nothing claimable, stop-and-notify.
    const queueEmptied = report.claimed.length === 0;
    if (queueEmptied) {
      const auditReport = await deps.runAudit(buildAuditOpts(opts));
      const enqueued = auditReport.enqueued?.appended ?? 0;
      if (enqueued === 0) {
        await deps.notify(
          `queue empty and target unmet; the work-bridge audit produced nothing claimable. Failing required: [${lastFailingRequired.join(", ") || "none"}].`,
        );
        return { goalMet: false, iterations, reason: "queue-empty-goal-unmet", built, target, failingRequired: lastFailingRequired };
      }
      // Audit enqueued work — continue to the next iteration to drain it (still under caps).
    }

    // Re-evaluate the target after the drain.
    ({ passing, failingRequired } = await evalTarget());
    lastFailingRequired = failingRequired;

    // Track whether the failing-required set stayed CONSTANT across the run (for the
    // unsatisfiable-target notify on cap-hit).
    if (constantFailingRequired === null) constantFailingRequired = failingRequired;
    else if (!sameSet(constantFailingRequired, failingRequired)) failingEverChanged = true;

    // Met now?
    if (goalMet(setToRecord(passing, targetSet), targetSet)) {
      return decideMet();
    }

    // No-progress detector (spec 5.4): distinct from the failure breaker. If the drain ran green
    // (it did — no breaker trip) but the set of PASSING TARGET criteria is unchanged from the
    // prior iteration, increment a stall counter; stop after K stalls. Reduces over the TARGET
    // passing-set so a slice does not stall just because untargeted criteria didn't move.
    const passingKey = [...passing].sort().join("|");
    if (prevPassingKey !== null && passingKey === prevPassingKey) {
      stall++;
      if (stall >= NO_PROGRESS_STALL_LIMIT) {
        await deps.notify(
          `autonomous-to-goal stopped: no progress on the target passing-set across ${stall} iterations. Failing required: [${failingRequired.join(", ") || "none"}].`,
        );
        return { goalMet: false, iterations, reason: "no-progress", built, target, failingRequired };
      }
    } else {
      stall = 0;
    }
    prevPassingKey = passingKey;
  }

  // Cap: maxIterations exhausted.
  return capHit(iterations, built, target, lastFailingRequired, constantFailingRequired, !failingEverChanged, deps);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True iff `target` is exactly the all-required id set (the WHOLE star). */
function isAllRequired(target: Set<string>, required: Set<string>): boolean {
  if (target.size !== required.size) return false;
  for (const id of target) if (!required.has(id)) return false;
  return true;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

/** Build a {id: passing} record over the target ids for the goalMet reducer. */
function setToRecord(passing: Set<string>, target: Set<string>): Record<string, boolean> {
  const rec: Record<string, boolean> = {};
  for (const id of target) rec[id] = passing.has(id);
  return rec;
}

/** Drain opts for one iteration — threads the in-drain early-stop seam + target slice. The
 * identity fields and the early-stop seam are authoritative: drainOpts pass-through (n, breaker,
 * land, …) is spread FIRST, then the fields runToGoal owns override it. */
function buildDrainOpts(opts: RunToGoalOptions, target: string[]): DrainOptions {
  return {
    ...opts.drainOpts,
    surface: opts.surface,
    queuePath: opts.queuePath,
    repoRoot: opts.repoRoot,
    briefPath: opts.briefPath,
    stopWhenBriefMet: true,
    targetCriteria: target,
  };
}

/** Drain opts for the unconfirmed/absent count-bounded fallback (NO early-stop). */
function buildCountBoundedDrainOpts(opts: RunToGoalOptions): DrainOptions {
  return {
    ...opts.drainOpts,
    surface: opts.surface,
    queuePath: opts.queuePath,
    repoRoot: opts.repoRoot,
  };
}

async function runOneCountBoundedDrain(opts: RunToGoalOptions, deps: RunToGoalDeps): Promise<number> {
  const report = await deps.runDrain(buildCountBoundedDrainOpts(opts));
  return report.succeeded.length;
}

/** The work-bridge audit pass: aimed at the surface (the failing target criteria all live on the
 * run's surface in this epic — runToGoal drives one surface). decisionsPath defaults to repoRoot
 * (the real wiring overrides via drainOpts if a project co-locates decisions elsewhere). */
function buildAuditOpts(opts: RunToGoalOptions): AuditOptions {
  return {
    target: opts.surface,
    queuePath: opts.queuePath,
    repoRoot: opts.repoRoot,
    decisionsPath: opts.repoRoot,
  };
}

/** The cap-hit terminal — with the unsatisfiable-target flag when the failing-required set was
 * CONSTANT across the whole run (spec 5.4 unsatisfiable-target note). */
function capHit(
  iterations: number,
  built: number,
  target: string[],
  failingRequired: string[],
  constantFailingRequired: string[] | null,
  failingWasConstant: boolean,
  deps: RunToGoalDeps,
): RunToGoalResult {
  const constant = failingWasConstant && (constantFailingRequired?.length ?? 0) > 0;
  if (constant) {
    void deps.notify(
      `cap hit with a CONSTANT failing-required set [${constantFailingRequired!.join(", ")}] — this target is likely UNSATISFIABLE / over-specified. Fix the brief rather than re-running.`,
    );
  } else {
    void deps.notify(
      `autonomous-to-goal cap hit after ${iterations} iteration(s). Failing required: [${failingRequired.join(", ") || "none"}].`,
    );
  }
  return { goalMet: false, iterations, reason: "cap-hit", built, target, failingRequired };
}
