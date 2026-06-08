// tools/orchestrator/breaker.ts
// Loop-safety pure logic: the sliding-window circuit breaker and the per-item
// runaway-budget comparison. Pure functions — the driver session feeds them
// outcomes and budgets and acts on the boolean.

/**
 * Sliding-window circuit breaker: trip when the number of failures within the
 * last `window` outcomes reaches `maxFailures`. A window (NOT "N consecutive") so
 * succeed-fail-succeed-fail can't evade it. `recent`: true = success, false = fail.
 */
export function shouldTrip(recent: boolean[], maxFailures: number, window: number): boolean {
  const slice = recent.slice(-window);
  const failures = slice.filter((ok) => !ok).length;
  return failures >= maxFailures;
}

/** The per-item runaway guard's comparison (turns / tool-calls / wall-clock). */
export function overBudget(used: number, limit: number): boolean {
  return used > limit;
}

/**
 * Success-termination reducer: is the WHOLE `target` set met?
 *
 * Returns true IFF `target` is NON-EMPTY and every id in `target` is both
 * present in `checked` AND passing. This is a PURE, target-agnostic primitive:
 * part-or-all targeting is expressed entirely by WHAT the caller passes as
 * `target` (a slice or the whole id-set) — there is no extra parameter, and the
 * reducer never decides the target itself.
 *
 * EMPTY `target` => false. The vacuous-truth answer ("∀ over ∅ is true") is the
 * WRONG default for a termination gate: "nothing checked / nothing to drive
 * toward" must NEVER mean "done". This guard is load-bearing (see spec §3.2,
 * §5.4 point 4, §5.4 "must NOT relax" — the empty-set guard stays).
 *
 * `checked` maps criterion id -> pass/fail. An id in `target` that is ABSENT
 * from `checked` is treated as not-yet-passing (false), so an unevaluated target
 * id can never accidentally count as met.
 */
export function goalMet(
  checked: Record<string, boolean> | Map<string, boolean>,
  target: Set<string>,
): boolean {
  if (target.size === 0) return false; // empty-set => false (vacuous-truth guard)
  const lookup = (id: string): boolean =>
    checked instanceof Map ? checked.get(id) === true : checked[id] === true;
  for (const id of target) {
    if (!lookup(id)) return false;
  }
  return true;
}
