// src/engine/reflect.ts
// Loop C — milestone reflection (spec 5.5). The thin seam that turns a milestone
// completion into (1) a logged ReflectionRecord and (2) — ONLY on an explicit
// milestone marker, rate-limited, batched — a brief-update PROPOSAL staged through
// the existing human-gate (emitPark → queue.md @parked + NOW.md "## Parked" + sinks).
//
// INV-A (the whole point of this phase): this file imports NO brief writer. The
// proposedUpdate / proposedConventions / proposedGlossary are TEXT/DATA ONLY —
// appended to the run LOG via appendReflection and staged via emitPark. There is no
// writeFileSync(briefPath) / Bun.write(briefPath) anywhere on this path; brief.ts
// exports no writer, so one cannot be imported here.
//
// Two trigger shapes (spec 5.5):
//   - per-feature LAND  → milestone:false → a LIGHTWEIGHT note (learned/onPath), NO
//                          proposedUpdate, NO park.
//   - explicit MILESTONE → milestone:true (epic completion / --milestone) → the full
//                          note MAY carry a proposedUpdate (conventions/glossary growth
//                          BATCHED into the single proposal) which is parked — UNLESS a
//                          brief-update proposal is already parked (the rate-limit).
import type { GlossaryEntry } from "./brief";
import type { ReflectionRecord } from "./digest";
import { appendReflection } from "./digest";
import { parseQueue } from "./queue";

/** The fixed title of the parked brief-update proposal. Single constant so the
 *  rate-limit detector and the park emitter agree on the surface to scan. */
export const BRIEF_UPDATE_PARK_TITLE = "brief-update proposed";

export interface RunReflectOptions {
  /** The milestone marker (epic name / --milestone label / feature title for a land). */
  milestone: string;
  /** What the milestone/feature taught us. */
  learned: string[];
  briefStillValid: boolean;
  onPath: boolean;
  driftedCriteria?: string[];
  /** TRUE only for an EXPLICIT milestone marker (epic completion / --milestone). When false
   *  (a per-feature land), a lightweight note is logged and NO proposal is ever staged. */
  isMilestone: boolean;
  /** Proposed brief delta (prose) — staged ONLY when isMilestone and not rate-limited. */
  proposedUpdate?: string;
  /** Proposed new conventions — batched into the single proposal (never a park per term). */
  proposedConventions?: string[];
  /** Proposed new glossary terms — batched into the single proposal. */
  proposedGlossary?: GlossaryEntry[];
  /** The run log the reflection is appended to. */
  logPath: string;
  /** The queue.md scanned for an already-parked brief-update proposal (the rate-limit). */
  queuePath: string;
}

export interface RunReflectDeps {
  /** Append the reflection to the run log (digest.appendReflection in the real wiring). */
  appendReflection(logPath: string, r: ReflectionRecord): Promise<void>;
  /** Stage the brief-update proposal through the human-gate (park.emitPark in the real wiring).
   *  This is the ONLY side-effecting writer on the path, and it touches queue.md/NOW.md/sinks —
   *  NEVER brief.ts (INV-A). */
  emitPark(title: string, reason: string): Promise<void>;
  /** Read the queue markdown (for the already-parked rate-limit scan). */
  readQueue(queuePath: string): Promise<string>;
}

export interface RunReflectResult {
  /** The reflection record that was logged. */
  record: ReflectionRecord;
  /** True iff a brief-update proposal was staged via emitPark this call. */
  parked: boolean;
  /** Why no park was staged (when parked === false). */
  suppressedReason?: "not-a-milestone" | "nothing-proposed" | "already-parked";
}

/** Does the proposal carry any brief delta at all (prose OR conventions OR glossary growth)? */
function hasProposal(o: RunReflectOptions): boolean {
  return Boolean(
    (o.proposedUpdate && o.proposedUpdate.trim()) ||
      (o.proposedConventions && o.proposedConventions.length) ||
      (o.proposedGlossary && o.proposedGlossary.length),
  );
}

/** Is a brief-update proposal already parked awaiting human review (the rate-limit)? */
function isAlreadyParked(queueMd: string): boolean {
  const items = parseQueue(queueMd);
  return items.some((i) => i.status === "parked" && i.title === BRIEF_UPDATE_PARK_TITLE);
}

/** One compact park reason line that BATCHES the prose + conventions + glossary deltas into a
 *  single proposal (spec 5.5: NOT one park per term). */
function batchedParkReason(o: RunReflectOptions): string {
  const parts: string[] = [];
  if (o.proposedUpdate && o.proposedUpdate.trim()) parts.push(o.proposedUpdate.trim());
  if (o.proposedConventions && o.proposedConventions.length) {
    parts.push(`new conventions: ${o.proposedConventions.join("; ")}`);
  }
  if (o.proposedGlossary && o.proposedGlossary.length) {
    parts.push(`new glossary: ${o.proposedGlossary.map((g) => `${g.term}=${g.means}`).join("; ")}`);
  }
  return `[milestone ${o.milestone}] proposed brief update (human-gated — review before any edit): ${parts.join(" | ")}`;
}

/**
 * Run the milestone reflection. ALWAYS logs a ReflectionRecord. Stages a single, batched,
 * rate-limited brief-update proposal via emitPark ONLY when:
 *   - this is an explicit milestone marker (isMilestone), AND
 *   - there is a proposal to make, AND
 *   - no brief-update proposal is already parked.
 * Returns whether a park was staged and (if not) why it was suppressed. Never writes brief.ts.
 */
export async function runReflect(opts: RunReflectOptions, deps: RunReflectDeps): Promise<RunReflectResult> {
  // A per-feature land logs ONLY a lightweight note (learned/onPath) — strip any proposal so the
  // log never records a brief delta on the non-milestone path (spec 5.5).
  const isLightweight = !opts.isMilestone;
  const record: ReflectionRecord = {
    milestone: opts.milestone,
    learned: opts.learned,
    briefStillValid: opts.briefStillValid,
    onPath: opts.onPath,
    ...(opts.driftedCriteria && opts.driftedCriteria.length ? { driftedCriteria: opts.driftedCriteria } : {}),
    ...(!isLightweight && opts.proposedUpdate ? { proposedUpdate: opts.proposedUpdate } : {}),
    ...(!isLightweight && opts.proposedConventions && opts.proposedConventions.length
      ? { proposedConventions: opts.proposedConventions }
      : {}),
    ...(!isLightweight && opts.proposedGlossary && opts.proposedGlossary.length
      ? { proposedGlossary: opts.proposedGlossary }
      : {}),
  };

  await deps.appendReflection(opts.logPath, record);

  if (isLightweight) {
    return { record, parked: false, suppressedReason: "not-a-milestone" };
  }
  if (!hasProposal(opts)) {
    return { record, parked: false, suppressedReason: "nothing-proposed" };
  }

  // RATE-LIMIT: no new proposal while one is already parked awaiting human review.
  const queueMd = await deps.readQueue(opts.queuePath);
  if (isAlreadyParked(queueMd)) {
    return { record, parked: false, suppressedReason: "already-parked" };
  }

  // Stage the SINGLE batched proposal via the human-gate. No brief write happens here.
  await deps.emitPark(BRIEF_UPDATE_PARK_TITLE, batchedParkReason(opts));
  return { record, parked: true };
}
