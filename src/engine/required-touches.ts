// tools/orchestrator/required-touches.ts
// The "touched too little" matrix (project-specific binding). Only MECHANICAL
// rules live here — a rule fires when a change of `whenStatus` matches `whenGlob`,
// and then requires some change to match `requireGlob`. Judgment-level completeness
// (docs actually correct, memory updated, epic map current) is the cold-review
// checklist in the thebashway skill, NOT here. See the spec's required-touches table.
import type { CheckResult } from "./verify/types";
import type { FileChange } from "./verify/run";

export interface TouchRule {
  name: string;
  whenStatus: Array<"A" | "M" | "D">;
  whenGlob: string;
  requireGlob: string;
  message: string;
}

export const REQUIRED_TOUCHES: TouchRule[] = [
  {
    name: "organ-added-registry",
    whenStatus: ["A"],
    whenGlob: "organs/src/sections/*/index.ts",
    requireGlob: "organs/src/registry.ts",
    message: "added an organ (new sections/*/index.ts) but organs/src/registry.ts is unchanged",
  },
  {
    name: "organ-removed-registry",
    whenStatus: ["D"],
    whenGlob: "organs/src/sections/*/index.ts",
    requireGlob: "organs/src/registry.ts",
    message: "removed an organ (deleted sections/*/index.ts) but organs/src/registry.ts is unchanged",
  },
];

/**
 * For each rule: if any change matches its status+trigger glob, require that some
 * change matches its require glob. A rule that doesn't fire is vacuously ok.
 */
export function checkRequiredTouches(
  changes: FileChange[],
  rules: TouchRule[] = REQUIRED_TOUCHES,
): CheckResult[] {
  return rules.map((rule) => {
    const trigGlob = new Bun.Glob(rule.whenGlob);
    const reqGlob = new Bun.Glob(rule.requireGlob);
    const fired = changes.some(
      (c) => rule.whenStatus.includes(c.status) && trigGlob.match(c.path),
    );
    if (!fired) return { name: `required:${rule.name}`, ok: true };
    const satisfied = changes.some((c) => reqGlob.match(c.path));
    return {
      name: `required:${rule.name}`,
      ok: satisfied,
      detail: satisfied ? undefined : rule.message,
    };
  });
}
