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
