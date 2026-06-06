import { describe, expect, test } from "bun:test";
import { buildBashaPrompt } from "../basha-prompt";
import { DESIGN_BAR, isUiTerritory } from "../design-bar";
import type { Lesson as OrchestratorLesson } from "../lessons";
import type { Lesson as OperatingLesson } from "../operating-lessons";

const buildLesson: OrchestratorLesson = { tag: "general", rule: "Always run verify before committing." };
const operatingLesson: OperatingLesson = { areas: ["hygiene"], body: "ISO 8601 dates always." };

describe("buildBashaPrompt — no lessons", () => {
  test("returns empty string when both lesson arrays are empty (design bar suppressed)", () => {
    // The design bar is now appended by default, so empty-in/empty-out only holds with
    // designBar:false. See design-bar.ts + the 2026-06-06 design-quality spec.
    const out = buildBashaPrompt({ buildLessons: [], operatingLessons: [], taskBody: "", designBar: false });
    expect(out.trim()).toBe("");
  });
});

describe("buildBashaPrompt — design bar", () => {
  test("appends the design bar by default, AFTER the task body", () => {
    const out = buildBashaPrompt({ buildLessons: [], operatingLessons: [], taskBody: "Implement the feature." });
    const taskIdx = out.indexOf("Implement the feature.");
    const barIdx = out.indexOf("Design bar");
    expect(barIdx).toBeGreaterThan(taskIdx);
    expect(out).toContain(DESIGN_BAR);
  });

  test("design bar carries the short-circuit opener and points at the project's design system", () => {
    const out = buildBashaPrompt({ buildLessons: [], operatingLessons: [], taskBody: "x" });
    expect(out).toContain("ignore the rest of this section");
    expect(out).toContain("design system");
  });

  test("designBar:false omits it entirely", () => {
    const out = buildBashaPrompt({ buildLessons: [], operatingLessons: [], taskBody: "x", designBar: false });
    expect(out).not.toContain("Design bar");
  });
});

describe("isUiTerritory", () => {
  test("true for frontend extensions and UI directories", () => {
    expect(isUiTerritory(["src/components/Card.tsx"])).toBe(true);
    expect(isUiTerritory(["app/views/page.vue"])).toBe(true);
    expect(isUiTerritory(["assets/styles/main.scss"])).toBe(true);
  });
  test("false for pure backend territory", () => {
    expect(isUiTerritory(["src/lib/db.ts"])).toBe(false);
    expect(isUiTerritory(["server/routes.ts", "scripts/seed.ts"])).toBe(false);
    expect(isUiTerritory([])).toBe(false);
  });
});

describe("buildBashaPrompt — operating-lessons block", () => {
  test("renders Standing substrate rules block when operating lessons provided", () => {
    const out = buildBashaPrompt({ buildLessons: [], operatingLessons: [operatingLesson], taskBody: "" });
    expect(out).toContain("Standing substrate rules");
    expect(out).toContain("[hygiene] ISO 8601 dates always.");
  });
});

describe("buildBashaPrompt — build-lessons block", () => {
  test("renders Known pitfalls block when build lessons provided", () => {
    const out = buildBashaPrompt({ buildLessons: [buildLesson], operatingLessons: [], taskBody: "" });
    expect(out).toContain("Known pitfalls");
    expect(out).toContain("(general) Always run verify before committing.");
  });
});

describe("buildBashaPrompt — ordering", () => {
  test("Standing substrate rules appears before Known pitfalls", () => {
    const out = buildBashaPrompt({
      buildLessons: [buildLesson],
      operatingLessons: [operatingLesson],
      taskBody: "",
    });
    const substrateIdx = out.indexOf("Standing substrate rules");
    const pitfallsIdx = out.indexOf("Known pitfalls");
    expect(substrateIdx).toBeGreaterThanOrEqual(0);
    expect(pitfallsIdx).toBeGreaterThanOrEqual(0);
    expect(substrateIdx).toBeLessThan(pitfallsIdx);
  });

  test("task body appears after both lesson blocks", () => {
    const out = buildBashaPrompt({
      buildLessons: [buildLesson],
      operatingLessons: [operatingLesson],
      taskBody: "Implement the feature.",
    });
    const substrateIdx = out.indexOf("Standing substrate rules");
    const taskIdx = out.indexOf("Implement the feature.");
    expect(taskIdx).toBeGreaterThan(substrateIdx);
  });
});

describe("buildBashaPrompt — area filter", () => {
  test("only lessons matching the area filter appear in the operating block", () => {
    const lessons: OperatingLesson[] = [
      { areas: ["hygiene"], body: "ISO 8601 dates always." },
      { areas: ["people"], body: "People-handling rule." },
    ];
    const out = buildBashaPrompt({
      buildLessons: [],
      operatingLessons: lessons,
      taskBody: "",
    });
    // Default area filter is meta/hygiene/zone/infra/cost — people is excluded.
    expect(out).toContain("ISO 8601 dates always.");
    expect(out).not.toContain("People-handling rule.");
  });

  test("custom areas override the default filter", () => {
    const lessons: OperatingLesson[] = [
      { areas: ["people"], body: "People-handling rule." },
    ];
    const out = buildBashaPrompt({
      buildLessons: [],
      operatingLessons: lessons,
      operatingAreas: ["people"],
      taskBody: "",
    });
    expect(out).toContain("People-handling rule.");
  });
});
