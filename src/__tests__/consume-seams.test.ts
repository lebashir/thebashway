// Tests for the seams added so a repo (e.g. lifeofbash) can CONSUME the package and keep its own
// data locations, design system, and completeness rules — the generalizations the consume needs.
import { test, expect } from "bun:test";
import { derivePaths } from "../cli";
import { drainPaths } from "../engine/drain";
import { defineThebashway, type ProjectBinding } from "../binding";
import { setBinding, resetBinding, getDesignBar, SURFACES } from "../engine/config";
import { checkRequiredTouches } from "../engine/required-touches";

const base: ProjectBinding = {
  repoRoot: "/repo",
  defaultSurface: "app",
  surfaces: { app: { dir: ".", role: "x", chain: [] } },
  rails: { territoryGlobs: [], keywords: /x/, requireBrief: false },
  learning: { global: null, local: ".tbw/lessons.md", decisions: ".tbw/decisions.md" },
};

test("derivePaths: defaults every loop-data path to .thebashway/*", () => {
  const p = derivePaths(defineThebashway({ ...base }));
  expect(p.queuePath).toBe("/repo/.thebashway/queue.md");
  expect(p.runLogPath).toBe("/repo/.thebashway/run-log.md");
  expect(p.nowPath).toBe("/repo/.thebashway/NOW.md");
  expect(p.manifestPath).toBe("/repo/.thebashway/.verify-manifest.json");
});

test("derivePaths: binding.paths overrides — a consumer keeps data elsewhere + NOW.md at the repo root", () => {
  const p = derivePaths(
    defineThebashway({
      ...base,
      paths: {
        queue: "tools/orchestrator/queue.md",
        runLog: "tools/orchestrator/run-log.md",
        now: "NOW.md",
        manifest: "tools/orchestrator/.verify-manifest.json",
      },
    }),
  );
  expect(p.queuePath).toBe("/repo/tools/orchestrator/queue.md");
  expect(p.runLogPath).toBe("/repo/tools/orchestrator/run-log.md");
  expect(p.nowPath).toBe("/repo/NOW.md"); // F1: park refreshes the REAL root NOW.md, not .thebashway/NOW.md
  expect(p.manifestPath).toBe("/repo/tools/orchestrator/.verify-manifest.json");
});

test("drainPaths: a single-surface repo at root (no paths) — the OUT-door loop derives root-relative locations, NOT lifeofbash's tools/", () => {
  // The thebashway dogfood shape: one surface at the repo root, default loop-data paths.
  const b = defineThebashway({ ...base });
  const dp = drainPaths(b, "app");
  expect(dp.surfaceDir).toBe(".");
  expect(dp.manifestRel).toBe(".thebashway/.verify-manifest.json");
  // dir "." → no redundant "./node_modules"; just the root link.
  expect(dp.nodeModulesLinks).toEqual(["node_modules"]);
});

test("drainPaths: a consumer with a subdir surface + custom manifest (lifeofbash shape) — derives tools/ from the binding, not a hardcode", () => {
  const b = defineThebashway({
    ...base,
    defaultSurface: "tools",
    surfaces: { tools: { dir: "tools", role: "x", chain: [] } },
    paths: { manifest: "tools/orchestrator/.verify-manifest.json" },
  });
  const dp = drainPaths(b, "tools");
  expect(dp.surfaceDir).toBe("tools");
  expect(dp.manifestRel).toBe("tools/orchestrator/.verify-manifest.json");
  // a subdir surface needs both the root node_modules and the surface's own.
  expect(dp.nodeModulesLinks).toEqual(["node_modules", "tools/node_modules"]);
});

test("getDesignBar: null by default, set from binding.designBar, cleared by resetBinding (F4)", () => {
  resetBinding();
  expect(getDesignBar()).toBeNull();
  setBinding(defineThebashway({ ...base, designBar: "GLASS: extend the project's design system." }));
  expect(getDesignBar()).toBe("GLASS: extend the project's design system.");
  resetBinding();
  expect(getDesignBar()).toBeNull();
});

test("requiredTouches: the binding's per-surface rules flow through SURFACES and actually fire (F3)", () => {
  setBinding(
    defineThebashway({
      ...base,
      surfaces: {
        app: {
          dir: ".",
          role: "x",
          chain: [],
          requiredTouches: [
            {
              name: "widget-needs-registry",
              whenStatus: ["A"],
              whenGlob: "src/widgets/*.ts",
              requireGlob: "src/registry.ts",
              message: "added a widget but src/registry.ts is unchanged",
            },
          ],
        },
      },
    }),
  );
  const rules = Object.values(SURFACES).flatMap((s) => s.requiredTouches ?? []);
  expect(rules.length).toBe(1);

  // A widget added WITHOUT touching the registry → the rule fires and FAILS (the real R3 check).
  const failing = checkRequiredTouches([{ status: "A", path: "src/widgets/foo.ts" }], rules);
  expect(failing.find((c) => c.name === "required:widget-needs-registry")?.ok).toBe(false);

  // Touch the registry too → satisfied.
  const passing = checkRequiredTouches(
    [
      { status: "A", path: "src/widgets/foo.ts" },
      { status: "M", path: "src/registry.ts" },
    ],
    rules,
  );
  expect(passing.find((c) => c.name === "required:widget-needs-registry")?.ok).toBe(true);
  resetBinding();
});
