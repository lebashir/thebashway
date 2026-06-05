// tools/orchestrator/digest.ts
// The run digest — the human's review surface. Fixed schema so it can't drift into
// uselessness. The full hash-anchored record goes to a dedicated log; a concise
// one-liner goes to NOW.md (see the spec's "two surfaces, one schema").
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
