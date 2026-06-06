// tools/orchestrator/verify/scope.ts
/**
 * Classify changed files against a unit's territory globs. `inside` = allowed;
 * `outside` = scope overrun (the failure-#1 guard). Uses Bun.Glob: `*` matches
 * within a path segment, `**` crosses segments.
 */
export function classifyChanges(
  changed: string[],
  territory: string[],
): { inside: string[]; outside: string[] } {
  const globs = territory.map((g) => new Bun.Glob(g));
  const inside: string[] = [];
  const outside: string[] = [];
  for (const file of changed) {
    if (globs.some((g) => g.match(file))) inside.push(file);
    else outside.push(file);
  }
  return { inside, outside };
}
