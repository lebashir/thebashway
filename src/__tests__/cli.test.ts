import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

test("main parses --config BEFORE the subcommand (the wired `bun run thebashway <verb>` ordering)", async () => {
  // A `bun run` script bakes `--config <path>` then bun appends the user's verb, so the shipped
  // `bun run thebashway audit-plan money` produces config-FIRST argv. This must resolve the plan,
  // NOT misparse `--config` as the subcommand and fall through to the bare-request classifier.
  const code = await main(["--config", "examples/lifeofbash.config.ts", "audit-plan", "money"], process.cwd());
  expect(code).toBe(0);
});

test("main init scaffolds a config in a fresh dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tbw-cli-"));
  const code = await main(["init"], dir);
  expect(existsSync(join(dir, "thebashway.config.ts"))).toBe(true);
  expect(existsSync(join(dir, ".thebashway/lessons.md"))).toBe(true);
  expect([0, 1]).toContain(code); // 1 only because a bare tmpdir isn't a git repo
});

test("main add-decision writes to the binding's decisions.md, parses [tag], and dedups", async () => {
  // A self-resolving tmp binding (absolute import of the package's own defineThebashway) writing
  // to a tmp decisions.md — avoids `init`'s package-name import (unresolvable in a bare dir) and
  // never touches a real project's files.
  const dir = mkdtempSync(join(tmpdir(), "tbw-cli-dec-"));
  const bindingMod = JSON.stringify(resolve(import.meta.dir, "../binding"));
  await Bun.write(
    join(dir, "thebashway.config.ts"),
    `import { defineThebashway } from ${bindingMod};\n` +
      `export default defineThebashway({\n` +
      `  repoRoot: ${JSON.stringify(dir)},\n` +
      `  defaultSurface: "app",\n` +
      `  surfaces: { app: { dir: ".", role: "r", chain: [] } },\n` +
      `  rails: { territoryGlobs: [], keywords: /a^/, requireBrief: false },\n` +
      `  learning: { local: ".thebashway/lessons.md", decisions: ".thebashway/decisions.md" },\n` +
      `});\n`,
  );
  const decisionsPath = join(dir, ".thebashway/decisions.md");
  expect(await main(["add-decision", "[tools] prefer X over Y"], dir)).toBe(0);
  expect(await Bun.file(decisionsPath).text()).toContain("[tools] prefer X over Y");
  // The same rule via --tag is a dedup no-op (still exit 0, still one occurrence).
  expect(await main(["add-decision", "prefer X over Y", "--tag", "tools"], dir)).toBe(0);
  const text = await Bun.file(decisionsPath).text();
  expect(text.match(/prefer X over Y/g)?.length).toBe(1);
  // No rule → usage error (does NOT fall through to the build/fix classifier).
  expect(await main(["add-decision"], dir)).toBe(2);
});

test("main queue: summary, --surface filter, --json (exit 0); unknown surface (exit 2 — not classifier)", async () => {
  const cfg = "examples/lifeofbash.config.ts";
  expect(await main(["queue", "--config", cfg], process.cwd())).toBe(0);
  expect(await main(["queue", "--surface", "organs", "--config", cfg], process.cwd())).toBe(0);
  expect(await main(["queue", "--json", "--config", cfg], process.cwd())).toBe(0);
  // A bad surface returns 2 from cmdQueue — proving `queue` did NOT fall through to the
  // bare-request build/fix classifier (which would never return 2 for an unknown surface).
  expect(await main(["queue", "--surface", "bogus", "--config", cfg], process.cwd())).toBe(2);
});
