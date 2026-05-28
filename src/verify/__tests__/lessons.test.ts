import { test, expect } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLessons, readLessons, relevantLessons, formatForPrompt, appendLesson } from "../../lessons";

const SAMPLE = `# lessons

Distilled pitfalls.

- [general] Use sonnet not haiku for bashas — haiku thrashes.
- [organs] Run pnpm build, never next build (skips snapshot regen).
- [worktree] Base worktrees on local HEAD when commits are unpushed.
`;

test("parseLessons reads `- [tag] rule` lines, ignores prose", () => {
  const ls = parseLessons(SAMPLE);
  expect(ls).toHaveLength(3);
  expect(ls[0]).toEqual({ tag: "general", rule: "Use sonnet not haiku for bashas — haiku thrashes." });
  expect(ls[1].tag).toBe("organs");
});

test("ignores lessons inside HTML comments (template examples are not live)", () => {
  const md = `# lessons\n<!--\n- [general] commented example, not a real lesson\n-->\n- [app] a real one\n`;
  const ls = parseLessons(md);
  expect(ls).toHaveLength(1);
  expect(ls[0].tag).toBe("app");
});

test("relevantLessons returns general + matching area, drops the rest", () => {
  const ls = parseLessons(SAMPLE);
  const r = relevantLessons(ls, ["organs"]);
  expect(r.map((l) => l.tag).sort()).toEqual(["general", "organs"]);
  // worktree-tagged lesson is excluded for an organs build
  expect(r.some((l) => l.tag === "worktree")).toBe(false);
});

test("formatForPrompt produces a Known-pitfalls block; empty for none", () => {
  expect(formatForPrompt([])).toBe("");
  const s = formatForPrompt(parseLessons(SAMPLE));
  expect(s).toContain("Known pitfalls — do not repeat:");
  expect(s).toContain("(organs)");
});

test("with `## Active` header, only Active-section lessons are parsed; Graduated ignored", () => {
  const md = `# lessons\n\nIntro prose.\n\n## Active\n\n- [organs] active one\n- [general] another active\n\n## Graduated\n\n- [general] this was retired\n- [organs] also retired\n`;
  const ls = parseLessons(md);
  expect(ls).toHaveLength(2);
  expect(ls.map((l) => l.rule)).toEqual(["active one", "another active"]);
});

test("without `## Active` header, whole doc is parsed (backward compatible)", () => {
  const ls = parseLessons(SAMPLE);
  expect(ls).toHaveLength(3);
});

test("appendLesson appends, and dedups identical rules", async () => {
  const p = join(tmpdir(), `lessons-${Math.random().toString(36).slice(2)}.md`);
  expect(await appendLesson(p, { tag: "general", rule: "always commit per task" })).toBe(true);
  expect(await appendLesson(p, { tag: "general", rule: "always commit per task" })).toBe(false); // dup
  expect(await appendLesson(p, { tag: "app", rule: "another rule" })).toBe(true);
  const ls = await readLessons(p);
  expect(ls).toHaveLength(2);
  expect(existsSync(p)).toBe(true);
  unlinkSync(p);
});

test("appendLesson inserts into `## Active` section (not after `## Graduated`)", async () => {
  const p = join(tmpdir(), `lessons-${Math.random().toString(36).slice(2)}.md`);
  await Bun.write(p, `# lessons\n\n## Active\n\n- [organs] first\n\n## Graduated\n\n- [general] old retired one\n`);
  expect(await appendLesson(p, { tag: "general", rule: "new active rule" })).toBe(true);
  const text = await Bun.file(p).text();
  const activeIdx = text.indexOf("## Active");
  const newIdx = text.indexOf("new active rule");
  const gradIdx = text.indexOf("## Graduated");
  expect(activeIdx).toBeGreaterThan(-1);
  expect(newIdx).toBeGreaterThan(activeIdx);
  expect(newIdx).toBeLessThan(gradIdx);
  // Still excludes the Graduated rule on read.
  const ls = await readLessons(p);
  expect(ls.map((l) => l.rule)).toEqual(["first", "new active rule"]);
  unlinkSync(p);
});
