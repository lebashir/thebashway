// src/engine/operating-lessons.ts
// Generic operating-lessons parser used by basha-prompt to inject substrate-wide
// (or any "global") standing rules into a build basha's prompt. This is the PORTABLE
// subset of lifeofbash's tools/substrate/operating-lessons.ts: just the read-side
// markdown parser, with none of the substrate-coupled write/propose/trust machinery.
// A project points binding.learning.global at whatever operating-lessons file it
// wants (or null for none).

export interface Lesson {
  areas: string[];
  body: string;
}

export interface ParsedLessons {
  active: Lesson[];
  graduated: Lesson[];
}

const ACTIVE_HEADER_RE = /^##\s+Active\b/i;
const GRADUATED_HEADER_RE = /^##\s+Graduated\b/i;
const ANY_H2_RE = /^##\s+/;
// Captures [area1] [area2] ... body (areas at start of line, body is the rest)
const BULLET_RE = /^\s*-\s*((?:\[[^\]]+\]\s*)+)(.+?)\s*$/;

export function parseLessons(md: string): ParsedLessons {
  // Strip HTML comments — commented-out examples are not real lessons.
  const stripped = md.replace(/<!--[\s\S]*?-->/g, "");
  const lines = stripped.split("\n");

  type Mode = "none" | "active" | "graduated";
  let mode: Mode = "none";
  const out: ParsedLessons = { active: [], graduated: [] };

  for (const line of lines) {
    if (ACTIVE_HEADER_RE.test(line)) {
      mode = "active";
      continue;
    }
    if (GRADUATED_HEADER_RE.test(line)) {
      mode = "graduated";
      continue;
    }
    if (ANY_H2_RE.test(line)) {
      // Any other H2 closes both sections.
      mode = "none";
      continue;
    }
    if (mode === "none") continue;
    const m = line.match(BULLET_RE);
    if (!m) continue;
    const areaPart = m[1]; // "[area1] [area2] "
    const body = m[2].trim();
    const areas = [...areaPart.matchAll(/\[([^\]]+)\]/g)].map((mm) => mm[1].trim());
    if (areas.length === 0) continue;
    out[mode].push({ areas, body });
  }
  return out;
}

export function activeLessonsByArea(md: string, area?: string | string[]): Lesson[] {
  const parsed = parseLessons(md);
  if (area === undefined) return parsed.active;
  const filter = new Set((Array.isArray(area) ? area : [area]).map((a) => a.toLowerCase()));
  return parsed.active.filter((l) => l.areas.some((a) => filter.has(a.toLowerCase())));
}
