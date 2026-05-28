// src/lessons.ts
// The lessons log — distilled build pitfalls that feed FORWARD into future bashas.
// Above the per-run digest (which logs raw anomalies), lessons are the curated
// rules: "what to never do again." Before dispatching a basha, the driver injects
// the relevant lessons into its prompt; after a gate/review catches a real mistake,
// it appends a one-line lesson (dedup is automatic, so "caught twice" logs once).
//
// File format: one `- [tag] rule` line per lesson (tag = area, or "general").
// Optional two-tier structure: an `## Active` section holds lessons that are
// still injected; an `## Graduated` section keeps history for lessons that are
// now encoded in code, automated, or moved into the cold-review prompt — these
// are NOT injected. If neither header exists, the whole document is parsed
// (backward-compatible with older projects).

export interface Lesson {
  tag: string;
  rule: string;
}

export function parseLessons(md: string): Lesson[] {
  const out: Lesson[] = [];
  // Strip HTML comments first — commented-out examples are not real lessons.
  const stripped = md.replace(/<!--[\s\S]*?-->/g, "");
  const lines = stripped.split("\n");
  const activeIdx = lines.findIndex((l) => /^##\s+Active\b/i.test(l));
  // No `## Active` header → entire doc is in scope (older single-tier format).
  let inScope = activeIdx === -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (activeIdx !== -1) {
      if (i === activeIdx) { inScope = true; continue; }
      // Any subsequent `## ...` header closes the Active section.
      if (i > activeIdx && /^##\s+/.test(line)) { inScope = false; continue; }
    }
    if (!inScope) continue;
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

/** Append a new lesson; no-op (returns false) if an identical rule already exists.
 * For the two-tier format: appends to the END of the `## Active` section (just
 * before the `## Graduated` header, if present). For the single-tier format
 * (no `## Active` header), appends to the end of the file. */
export async function appendLesson(path: string, lesson: Lesson): Promise<boolean> {
  const existing = await readLessons(path);
  if (existing.some((l) => l.rule === lesson.rule)) return false;
  const f = Bun.file(path);
  const head = (await f.exists()) ? await f.text() : "# lessons\n";
  const newLine = `- [${lesson.tag}] ${lesson.rule}\n`;

  const lines = head.split("\n");
  const activeIdx = lines.findIndex((l) => /^##\s+Active\b/i.test(l));
  if (activeIdx === -1) {
    // Single-tier: append to end (backward-compatible).
    const sep = head.endsWith("\n") ? "" : "\n";
    await Bun.write(path, `${head}${sep}${newLine}`);
    return true;
  }
  // Two-tier: find the end of the Active section (the next `## ...` header,
  // or end of file). Insert just before that boundary, trimming trailing blank
  // lines so the new entry sits with its siblings.
  let endIdx = lines.length;
  for (let i = activeIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { endIdx = i; break; }
  }
  // Walk back over trailing blank lines inside the section.
  let insertAt = endIdx;
  while (insertAt > activeIdx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  const before = lines.slice(0, insertAt).join("\n");
  const after = lines.slice(insertAt).join("\n");
  const sep = before.endsWith("\n") ? "" : "\n";
  const blank = after.length ? "\n" : "";
  await Bun.write(path, `${before}${sep}${newLine.trimEnd()}\n${blank}${after}`);
  return true;
}
