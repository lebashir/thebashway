// tools/orchestrator/required-touches.ts  (PROJECT-SPECIFIC — copy + adapt)
// The "touched too little" matrix: mechanical completeness rules for THIS project.
// A rule fires when a change of `whenStatus` matches `whenGlob`, then requires some
// change to match `requireGlob`. Start empty; add rules as conventions emerge.
// Judgment-level completeness (docs correct, memory updated) is the cold-review
// checklist in the thebashway skill, not here.
import type { TouchRule } from "thebashway";

export const REQUIRED_TOUCHES: TouchRule[] = [
  // Example: adding a new section module must also register it.
  // {
  //   name: "section-added-registry",
  //   whenStatus: ["A"],
  //   whenGlob: "app/src/sections/*/index.ts",
  //   requireGlob: "app/src/registry.ts",
  //   message: "added a section (new sections/*/index.ts) but registry.ts is unchanged",
  // },
];
