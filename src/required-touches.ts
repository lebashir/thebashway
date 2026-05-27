// src/required-touches.ts
// The "touched too little" completeness check. GENERIC: the type + the matcher.
// The actual rules are PROJECT-SPECIFIC and supplied by each project (see
// template/required-touches.ts). Only mechanical rules belong here; judgment-level
// completeness (docs correct, memory updated) is the cold-review checklist in the
// thebashway skill.
import type { CheckResult } from "./verify/types";
import type { FileChange } from "./verify/run";

export interface TouchRule {
  name: string;
  whenStatus: Array<"A" | "M" | "D">;
  whenGlob: string;
  requireGlob: string;
  message: string;
}

/**
 * For each rule: if any change matches its status+trigger glob, require that some
 * change matches its require glob. A rule that doesn't fire is vacuously ok.
 */
export function checkRequiredTouches(changes: FileChange[], rules: TouchRule[]): CheckResult[] {
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
