import { test, expect } from "bun:test";
import { classifyModeHeuristic, classifyMode } from "../router";

test("heuristic routes clear build phrasing", () => {
  expect(classifyModeHeuristic("build a CSV export feature")).toBe("build");
  expect(classifyModeHeuristic("add a dark-mode toggle")).toBe("build");
  expect(classifyModeHeuristic("implement pagination")).toBe("build");
  expect(classifyModeHeuristic("scaffold a settings page")).toBe("build");
});

test("heuristic routes clear fix phrasing", () => {
  expect(classifyModeHeuristic("the login button is broken")).toBe("fix");
  expect(classifyModeHeuristic("audit the auth module")).toBe("fix");
  expect(classifyModeHeuristic("clean up the date utils")).toBe("fix");
  expect(classifyModeHeuristic("refactor the parser")).toBe("fix");
});

test("heuristic returns null when ambiguous (both signals or neither)", () => {
  expect(classifyModeHeuristic("add a fix for the broken export")).toBeNull(); // both
  expect(classifyModeHeuristic("look at the money page")).toBeNull(); // neither
});

test("classifyMode uses the LLM only when ambiguous, and honors its answer", async () => {
  let called = 0;
  const fake = async () => {
    called++;
    return { ok: true, stdout: "build\n", exitCode: 0, timedOut: false };
  };
  const mode = await classifyMode("look at the money page", { runClaude: fake as any, cwd: "/tmp" });
  expect(mode).toBe("build");
  expect(called).toBe(1);
});

test("classifyMode skips the LLM for clear phrasing", async () => {
  let called = 0;
  const fake = async () => {
    called++;
    return { ok: true, stdout: "fix", exitCode: 0, timedOut: false };
  };
  const mode = await classifyMode("build a new dashboard", { runClaude: fake as any, cwd: "/tmp" });
  expect(mode).toBe("build");
  expect(called).toBe(0);
});

test("classifyMode defaults to fix when the LLM is unusable", async () => {
  const fake = async () => ({ ok: false, stdout: "", exitCode: null, timedOut: true });
  const mode = await classifyMode("look at the money page", { runClaude: fake as any, cwd: "/tmp" });
  expect(mode).toBe("fix");
});
