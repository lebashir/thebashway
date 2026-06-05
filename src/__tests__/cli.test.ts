import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { derivePaths, loadBinding, main } from "../cli";
import { defineThebashway } from "../binding";
import { resetBinding } from "../engine/config";

afterEach(() => resetBinding());

test("derivePaths resolves the stores under the repo root", () => {
  const b = defineThebashway({
    repoRoot: "/repo",
    defaultSurface: "app",
    surfaces: { app: { dir: ".", role: "r", chain: [] } },
    rails: { territoryGlobs: [], keywords: /a^/ },
    learning: { local: ".thebashway/lessons.md", decisions: ".thebashway/decisions.md" },
  });
  const p = derivePaths(b);
  expect(p.queuePath).toBe("/repo/.thebashway/queue.md");
  expect(p.lessonsPath).toBe("/repo/.thebashway/lessons.md");
  expect(p.decisionsPath).toBe("/repo/.thebashway/decisions.md");
  expect(p.globalLessons).toBeNull();
});

test("loadBinding throws a helpful error when no config exists", async () => {
  await expect(loadBinding({ cwd: join(tmpdir(), "no-such-dir-xyz-123") })).rejects.toThrow(/thebashway init/);
});

test("loadBinding imports + injects an existing config", async () => {
  const { binding, paths } = await loadBinding({ cwd: process.cwd(), configPath: "examples/lifeofbash.config.ts" });
  expect(Object.keys(binding.surfaces)).toContain("organs");
  expect(paths.repoRoot).toBe("/Users/bachir.habib/lifeofbash");
});

test("main help returns 0", async () => {
  expect(await main(["help"], process.cwd())).toBe(0);
  expect(await main([], process.cwd())).toBe(0);
});

test("main audit-plan resolves + prints the plan from the injected binding", async () => {
  const code = await main(["audit-plan", "money", "--config", "examples/lifeofbash.config.ts"], process.cwd());
  expect(code).toBe(0);
});

test("main init scaffolds a config in a fresh dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tbw-cli-"));
  const code = await main(["init"], dir);
  expect(existsSync(join(dir, "thebashway.config.ts"))).toBe(true);
  expect(existsSync(join(dir, ".thebashway/lessons.md"))).toBe(true);
  expect([0, 1]).toContain(code); // 1 only because a bare tmpdir isn't a git repo
});
