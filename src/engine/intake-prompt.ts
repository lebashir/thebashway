// tools/orchestrator/intake-prompt.ts
// Assembles the intake prompt's decision block (Loop A). Two-tier, mirroring
// basha-prompt.ts: an always-on GLOBAL tier (tag "decision") UNIONED with
// area-scoped rules (tag = the item's area). Territory-only filtering is
// deliberately NOT used — global defaults prevent the costliest question-stops
// and must always inject. See the spec, "Loop A — intake / decision learning."
import { relevantLessons, formatForPrompt, readLessons, type Lesson } from "./lessons";

export interface BuildIntakePromptOptions {
  /** All Active rules from decisions.md. */
  decisionLessons: Lesson[];
  /** The item's areas (surfaces/dirs), e.g. ["tools"]. */
  itemAreas: string[];
  /** The intake task body. */
  taskBody: string;
}

export function buildIntakePrompt(opts: BuildIntakePromptOptions): string {
  const { decisionLessons, itemAreas, taskBody } = opts;
  // "decision" is the always-on global tag; union it with the item's areas.
  const selected = relevantLessons(decisionLessons, ["decision", ...itemAreas]);
  const block = formatForPrompt(selected); // "Known pitfalls — do not repeat:" header is reused
  const parts: string[] = [];
  if (block) parts.push(block.replace("Known pitfalls — do not repeat:", "Decision defaults — apply before asking Bashir:"));
  if (taskBody) parts.push(taskBody);
  return parts.join("\n\n");
}

/** Convenience: read decisions.md from disk and assemble. */
export async function buildIntakePromptFromDisk(opts: {
  decisionsPath: string;
  itemAreas: string[];
  taskBody: string;
}): Promise<string> {
  const decisionLessons = await readLessons(opts.decisionsPath);
  return buildIntakePrompt({ decisionLessons, itemAreas: opts.itemAreas, taskBody: opts.taskBody });
}
