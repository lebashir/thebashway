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
