// Portability proof: the engine runs against a binding it has never seen, with
// zero lifeofbash leakage. setBinding swaps the project-specific values in place;
// resetBinding restores the defaults so other test files are unaffected.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { setBinding, resetBinding, SURFACES, AUDIT_TARGETS, getDefaultSurface } from "../engine/config";
import { resolveTarget } from "../engine/audit";
import { binding as nextjs } from "../../examples/nextjs-minimal.config";

beforeEach(() => setBinding(nextjs));
afterEach(() => resetBinding());

test("setBinding swaps the surfaces the engine sees — no organs/tools leakage", () => {
  expect(Object.keys(SURFACES).sort()).toEqual(["app"]);
  expect(SURFACES.organs).toBeUndefined();
  expect(SURFACES.tools).toBeUndefined();
  expect(getDefaultSurface()).toBe("app");
});

test("resolveTarget reads the injected audit registry", () => {
  const plan = resolveTarget("core");
  expect(plan.surface).toBe("app");
  expect(plan.rootGlob).toBe("src/**");
  expect(plan.subAreas).toContain("src/lib/**");
});

test("resolveTarget infers the injected surface for a directory path", () => {
  // dir "." is the catch-all → every path maps to "app" under this binding
  const plan = resolveTarget("src/server/email");
  expect(plan.surface).toBe("app");
});

test("a lifeofbash-only target no longer resolves under a different binding", () => {
  expect(() => resolveTarget("money")).toThrow(/cannot resolve target "money"/);
});

test("resetBinding restores the lifeofbash defaults", () => {
  resetBinding();
  expect(Object.keys(SURFACES).sort()).toEqual(["organs", "tools"]);
  expect(AUDIT_TARGETS.money).toBeDefined();
  expect(getDefaultSurface()).toBe("tools");
});
