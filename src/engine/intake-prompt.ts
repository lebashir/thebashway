// tools/orchestrator/intake-prompt.ts
// Assembles the intake prompt's decision block (Loop A). Two-tier, mirroring
// basha-prompt.ts: an always-on GLOBAL tier (tag "decision") UNIONED with
// area-scoped rules (tag = the item's area). Territory-only filtering is
// deliberately NOT used — global defaults prevent the costliest question-stops
// and must always inject. See the spec, "Loop A — intake / decision learning."
import { relevantLessons, formatForPrompt, readLessons, type Lesson } from "./lessons";
import { renderBriefForPrompt, type DesignBrief } from "./brief";
import { loadBrief, type LoadBriefResult } from "./load-brief";

export interface BuildIntakePromptOptions {
  /** All Active rules from decisions.md. */
  decisionLessons: Lesson[];
  /** The item's areas (surfaces/dirs), e.g. ["tools"]. */
  itemAreas: string[];
  /** The intake task body. */
  taskBody: string;
  /** The STABLE top layer: the per-project north star, rendered above the LEARNED decision
   *  defaults. Purely directional — the deterministic drift flag is the separate classifyDrift
   *  step, NOT an in-prompt instruction. Omitting it leaves the output byte-identical to today. */
  brief?: DesignBrief | null;
}

export function buildIntakePrompt(opts: BuildIntakePromptOptions): string {
  const { decisionLessons, itemAreas, taskBody, brief } = opts;
  // "decision" is the always-on global tag; union it with the item's areas.
  const selected = relevantLessons(decisionLessons, ["decision", ...itemAreas]);
  const block = formatForPrompt(selected); // "Known pitfalls — do not repeat:" header is reused
  const parts: string[] = [];
  // STABLE layer (the north star) sits ABOVE the LEARNED decision-defaults block. Directional
  // label only — no in-prompt "flag drift" instruction.
  if (brief) parts.push(`North star — build toward this:\n${renderBriefForPrompt(brief)}`);
  if (block) parts.push(block.replace("Known pitfalls — do not repeat:", "Decision defaults — apply before asking the owner:"));
  if (taskBody) parts.push(taskBody);
  return parts.join("\n\n");
}

/**
 * Convenience: read decisions.md from disk and assemble. The north star can be supplied two ways:
 *  - a PRE-LOADED `brief` (used directly), or
 *  - a `briefPath` — loaded HERE via loadBrief() so the one function named *FromDisk* actually loads
 *    the brief from disk (spec 5.2: design-run/audit-run callsites "Pass briefPath into both
 *    buildIntakePromptFromDisk calls"). `brief` takes precedence when both are given.
 *
 * The §3.1 parse-failure contract is honored: an `unparseable` brief at `briefPath` is NOT silently
 * dropped — it is surfaced to the caller via the optional `onBriefStatus` callback (the caller emits
 * the loud `emitPark`/`notify` signal), and the prompt is assembled WITHOUT the brief (status
 * 'absent' is the only benign "no brief" state). Omitting both `brief` and `briefPath` is byte-
 * identical to today.
 */
export async function buildIntakePromptFromDisk(opts: {
  decisionsPath: string;
  itemAreas: string[];
  taskBody: string;
  brief?: DesignBrief | null;
  briefPath?: string;
  /** Notified with loadBrief's result when `briefPath` is loaded here — the seam through which the
   *  caller emits the §3.1 loud signal on status:'unparseable'. Not called when `brief` is supplied
   *  pre-loaded or when `briefPath` is omitted. */
  onBriefStatus?: (result: LoadBriefResult) => void;
}): Promise<string> {
  const decisionLessons = await readLessons(opts.decisionsPath);
  let brief = opts.brief ?? null;
  if (!brief && opts.briefPath) {
    const result = await loadBrief(opts.briefPath);
    opts.onBriefStatus?.(result);
    brief = result.brief; // null on 'absent' or 'unparseable' — never silently treats broken as ok
  }
  return buildIntakePrompt({
    decisionLessons,
    itemAreas: opts.itemAreas,
    taskBody: opts.taskBody,
    brief,
  });
}
