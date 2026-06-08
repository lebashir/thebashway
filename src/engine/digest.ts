// tools/orchestrator/digest.ts
// The run digest — the human's review surface. Fixed schema so it can't drift into
// uselessness. The full hash-anchored record goes to a dedicated log; a concise
// one-liner goes to NOW.md (see the spec's "two surfaces, one schema").
import type { GlossaryEntry } from "./brief";

export interface DigestRecord {
  item: string;
  manifestHash: string;
  reviewVerdict: string;
  deployResult: string;
  anomalies: string[];
  /** Questions intake/build had to escalate to Bashir. The learning-loop metric. */
  questionsAsked: number;
}

/** Full fixed-schema record (the log line/block). Field order is fixed. */
export function formatRecord(r: DigestRecord): string {
  return [
    `- item: ${r.item}`,
    `  manifest: ${r.manifestHash}`,
    `  review: ${r.reviewVerdict}`,
    `  deploy: ${r.deployResult}`,
    `  anomalies: ${r.anomalies.length ? r.anomalies.join("; ") : "none"}`,
    `  questions: ${r.questionsAsked}`,
  ].join("\n");
}

/** Concise one-liner for NOW.md (surfaces blocked/anomalous items at a glance). */
export function summaryLine(r: DigestRecord): string {
  const flag = r.anomalies.length ? ` (anomalies: ${r.anomalies.join("; ")})` : "";
  const q = r.questionsAsked > 0 ? ` [${r.questionsAsked} question${r.questionsAsked === 1 ? "" : "s"}]` : "";
  return `${r.item} — ${r.deployResult}${flag}${q}`;
}

/** Append the full record to the run log (created if absent). */
export async function appendDigest(logPath: string, r: DigestRecord): Promise<void> {
  const f = Bun.file(logPath);
  const existing = (await f.exists()) ? await f.text() : "";
  await Bun.write(logPath, `${existing}${formatRecord(r)}\n\n`);
}

// ---------------------------------------------------------------------------
// Milestone reflection (Loop C — spec 5.5). A SEPARATE record from DigestRecord
// (which is FROZEN at 6 fields). The reflection is the human's review surface for
// "is the brief still valid / are we on path", and it CARRIES a proposed brief delta
// as TEXT/DATA ONLY. INV-A: there is no brief writer here — `proposedUpdate`,
// `proposedConventions`, and `proposedGlossary` are written to the run LOG (below)
// and staged via emitPark/sinks by the caller; NOTHING in this file writes brief.ts.
// ---------------------------------------------------------------------------

export interface ReflectionRecord {
  /** The milestone marker this reflection was triggered by (epic name / --milestone label). */
  milestone: string;
  /** What this milestone taught us (free-text bullets). The lightweight per-feature note
   *  carries only this + onPath; the full milestone note may also carry a proposedUpdate. */
  learned: string[];
  /** Is the north star itself still the right star? (human re-asks this at each milestone) */
  briefStillValid: boolean;
  /** Did the work track the brief, or drift? */
  onPath: boolean;
  /** Optional: which successCriteria ids the work drifted from (when onPath is false). */
  driftedCriteria?: string[];
  /** Optional: a proposed brief delta as PROSE — staged via emitPark, NEVER auto-written (INV-A). */
  proposedUpdate?: string;
  /** Optional: proposed new convention bullets — batched INTO the single proposedUpdate proposal. */
  proposedConventions?: string[];
  /** Optional: proposed new glossary terms — batched INTO the single proposedUpdate proposal. */
  proposedGlossary?: GlossaryEntry[];
}

/** Full fixed-shape reflection block (the log line/block) — mirrors formatRecord's style.
 *  Optional fields render only when present. */
export function formatReflection(r: ReflectionRecord): string {
  const lines = [
    `- milestone: ${r.milestone}`,
    `  learned: ${r.learned.length ? r.learned.join("; ") : "none"}`,
    `  briefStillValid: ${r.briefStillValid}`,
    `  onPath: ${r.onPath}`,
  ];
  if (r.driftedCriteria && r.driftedCriteria.length) {
    lines.push(`  driftedCriteria: ${r.driftedCriteria.join(", ")}`);
  }
  if (r.proposedUpdate) {
    lines.push(`  proposedUpdate: ${r.proposedUpdate}`);
  }
  if (r.proposedConventions && r.proposedConventions.length) {
    lines.push(`  proposedConventions: ${r.proposedConventions.join("; ")}`);
  }
  if (r.proposedGlossary && r.proposedGlossary.length) {
    lines.push(`  proposedGlossary: ${r.proposedGlossary.map((g) => `${g.term}=${g.means}`).join("; ")}`);
  }
  return lines.join("\n");
}

/** Append the reflection block to the run log (created if absent). Mirrors appendDigest's
 *  Bun.file read-append-write exactly. Writes ONLY to logPath — NEVER to a brief path (INV-A). */
export async function appendReflection(logPath: string, r: ReflectionRecord): Promise<void> {
  const f = Bun.file(logPath);
  const existing = (await f.exists()) ? await f.text() : "";
  await Bun.write(logPath, `${existing}${formatReflection(r)}\n\n`);
}
