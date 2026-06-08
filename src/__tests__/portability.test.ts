// Portability proof: the engine runs against a binding it has never seen, with
// zero lifeofbash leakage. setBinding swaps the project-specific values in place;
// resetBinding restores the defaults so other test files are unaffected.
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  setBinding,
  resetBinding,
  SURFACES,
  AUDIT_TARGETS,
  getDefaultSurface,
  getRepoRoot,
  getBriefPath,
  getBriefSensitivity,
  getRequireBrief,
} from "../engine/config";
import { resolveTarget } from "../engine/audit";
import { defineThebashway } from "../binding";
import { binding as nextjs } from "../../examples/nextjs-minimal.config";
import { binding as lifeofbash } from "../../examples/lifeofbash.config";

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

test("resolveTarget('.') maps to the default surface (whole-repo audit)", () => {
  const plan = resolveTarget(".");
  expect(plan.surface).toBe("app");
  expect(plan.subAreas.length).toBeGreaterThan(0);
});

test("getRepoRoot reflects the injected binding", () => {
  expect(getRepoRoot()).toBe("/tmp/nextjs-app");
});

test("getBriefPath / getBriefSensitivity are set by setBinding (nextjs: brief path + default sensitivity)", () => {
  // the nextjs config declares brief '.thebashway/brief.ts' and NO briefDriftSensitivity (=> 'medium')
  expect(getBriefPath()).toBe(".thebashway/brief.ts");
  expect(getBriefSensitivity()).toBe("medium");
});

test("getBriefPath reflects a DIFFERENT injected binding (lifeofbash points elsewhere)", () => {
  setBinding(lifeofbash);
  expect(getBriefPath()).toBe("tools/orchestrator/brief.ts");
  expect(getBriefSensitivity()).toBe("medium");
});

test("resetBinding restores the lifeofbash defaults", () => {
  resetBinding();
  expect(Object.keys(SURFACES).sort()).toEqual(["organs", "tools"]);
  expect(AUDIT_TARGETS.money).toBeDefined();
  expect(getDefaultSurface()).toBe("tools");
});

test("resetBinding restores the brief accessors — no cross-contamination after a swap", () => {
  // swap to lifeofbash (a different brief path) then reset; the accessors must return to defaults.
  setBinding(lifeofbash);
  expect(getBriefPath()).toBe("tools/orchestrator/brief.ts");
  resetBinding();
  expect(getBriefPath()).toBe(".thebashway/brief.ts");
  expect(getBriefSensitivity()).toBe("medium");
});

test("getRequireBrief reflects a requireBrief:false binding, then resetBinding restores the default true", () => {
  const optOut = defineThebashway({
    repoRoot: "/tmp/opt-out",
    defaultSurface: "app",
    surfaces: { app: { dir: ".", role: "default home", chain: [{ name: "test", cmd: ["bun", "test"] }] } },
    rails: { territoryGlobs: [], keywords: /a^/, requireBrief: false },
    learning: { global: null, local: ".thebashway/lessons.md", decisions: ".thebashway/decisions.md" },
  });
  setBinding(optOut);
  expect(getRequireBrief()).toBe(false);
  resetBinding();
  expect(getRequireBrief()).toBe(true);
});
