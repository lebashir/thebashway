import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProject, runInit } from "../init";

function tmpRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tbw-init-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

test("detectProject builds typecheck→test→build from scripts + tsconfig", async () => {
  const dir = tmpRepo({
    "package.json": JSON.stringify({ scripts: { build: "next build", test: "vitest" } }),
    "tsconfig.json": "{}",
    "next.config.js": "",
  });
  const d = await detectProject(dir);
  expect(d.isNext).toBe(true);
  expect(d.chain.map((c) => c.name)).toEqual(["typecheck", "test", "build"]);
});

test("detectProject picks the runner from the lockfile", async () => {
  const dir = tmpRepo({
    "package.json": JSON.stringify({ scripts: { test: "jest" } }),
    "pnpm-lock.yaml": "",
  });
  const d = await detectProject(dir);
  expect(d.runner).toBe("pnpm");
  expect(d.chain.find((c) => c.name === "test")?.cmd).toEqual(["pnpm", "run", "test"]);
});

test("detectProject yields an empty chain when nothing is detectable", async () => {
  const dir = tmpRepo({ "package.json": JSON.stringify({}) });
  const d = await detectProject(dir);
  expect(d.runner).toBe("npm");
  expect(d.chain).toEqual([]);
});

test("runInit scaffolds a config + local store, idempotently", async () => {
  const dir = tmpRepo({ "package.json": JSON.stringify({ scripts: { build: "echo b", test: "echo t" } }) });

  const r1 = await runInit(dir);
  expect(r1.created).toBe(true);
  expect(existsSync(join(dir, "thebashway.config.ts"))).toBe(true);
  expect(existsSync(join(dir, ".thebashway/lessons.md"))).toBe(true);
  expect(existsSync(join(dir, ".thebashway/decisions.md"))).toBe(true);

  const cfg = readFileSync(join(dir, "thebashway.config.ts"), "utf8");
  expect(cfg).toContain("defineThebashway");
  expect(cfg).toContain('defaultSurface: "app"');

  // second run does not clobber
  const r2 = await runInit(dir);
  expect(r2.created).toBe(false);
});

test("runInit threads a global lessons path into the config when given", async () => {
  const dir = tmpRepo({ "package.json": JSON.stringify({ scripts: { test: "echo t" } }) });
  await runInit(dir, { globalLessons: "/Users/x/lifeofbash/memory/operating-lessons.md" });
  const cfg = readFileSync(join(dir, "thebashway.config.ts"), "utf8");
  expect(cfg).toContain('global: "/Users/x/lifeofbash/memory/operating-lessons.md"');
});
