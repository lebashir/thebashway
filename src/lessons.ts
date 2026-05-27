// src/lessons.ts
// The lessons log — distilled build pitfalls that feed FORWARD into future bashas.
// Above the per-run digest (which logs raw anomalies), lessons are the curated
// rules: "what to never do again." Before dispatching a basha, the driver injects
// the relevant lessons into its prompt; after a gate/review catches a real mistake,
// it appends a one-line lesson (dedup is automatic, so "caught twice" logs once).
// File format: one `- [tag] rule` line per lesson (tag = area, or "general").

export interface Lesson {
  tag: string;
  rule: string;
}

export function parseLessons(md: string): Lesson[] {
  const out: Lesson[] = [];
  // Strip HTML comments first — commented-out examples are not real lessons.
  for (const line of md.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    const m = line.match(/^\s*-\s*\[([^\]]+)\]\s*(.+?)\s*$/);
    if (m) out.push({ tag: m[1].trim(), rule: m[2].trim() });
  }
  return out;
}

export async function readLessons(path: string): Promise<Lesson[]> {
  const f = Bun.file(path);
  return (await f.exists()) ? parseLessons(await f.text()) : [];
}

/** Lessons tagged "general" plus any matching one of the given areas (case-insensitive). */
export function relevantLessons(lessons: Lesson[], areas: string[]): Lesson[] {
  const set = new Set(["general", ...areas.map((a) => a.toLowerCase())]);
  return lessons.filter((l) => set.has(l.tag.toLowerCase()));
}

/** Format lessons for injection into a basha's prompt. Empty string if none. */
export function formatForPrompt(lessons: Lesson[]): string {
  if (lessons.length === 0) return "";
  return "Known pitfalls — do not repeat:\n" + lessons.map((l) => `- (${l.tag}) ${l.rule}`).join("\n");
}

/** Append a new lesson; no-op (returns false) if an identical rule already exists. */
export async function appendLesson(path: string, lesson: Lesson): Promise<boolean> {
  const existing = await readLessons(path);
  if (existing.some((l) => l.rule === lesson.rule)) return false;
  const f = Bun.file(path);
  const head = (await f.exists()) ? await f.text() : "# lessons\n";
  const sep = head.endsWith("\n") ? "" : "\n";
  await Bun.write(path, `${head}${sep}- [${lesson.tag}] ${lesson.rule}\n`);
  return true;
}
