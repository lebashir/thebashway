import { test, expect, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectProject,
  runInit,
  enablePluginInSettings,
  PLUGIN_ID,
  seedBriefIfAbsent,
  gatherBriefInputs,
  inferBriefDraft,
  initMessage,
  type InitResult,
} from "../init";
import { loadBrief } from "../engine/load-brief";

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

// --- per-project plugin activation (the nice-to-have) ---

test("enablePluginInSettings: absent settings → fresh file with the plugin enabled", () => {
  const r = enablePluginInSettings(null);
  expect(r.status).toBe("added");
  expect(JSON.parse(r.content).enabledPlugins[PLUGIN_ID]).toBe(true);
});

test("enablePluginInSettings: PRESERVES existing keys + other enabled plugins", () => {
  const raw = JSON.stringify({
    model: "opus",
    enabledPlugins: { "other@mkt": true },
    permissions: { allow: ["Bash(ls)"] },
  });
  const r = enablePluginInSettings(raw);
  expect(r.status).toBe("added");
  const out = JSON.parse(r.content);
  expect(out.model).toBe("opus"); // untouched
  expect(out.permissions.allow).toEqual(["Bash(ls)"]); // untouched
  expect(out.enabledPlugins["other@mkt"]).toBe(true); // other plugin kept
  expect(out.enabledPlugins[PLUGIN_ID]).toBe(true); // ours added
});

test("enablePluginInSettings: already-enabled → unchanged", () => {
  const raw = JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: true } });
  const r = enablePluginInSettings(raw);
  expect(r.status).toBe("already");
  expect(r.content).toBe(raw); // byte-identical, no rewrite
});

test("enablePluginInSettings: malformed JSON is left UNTOUCHED (never clobber)", () => {
  const raw = "{ not valid json ";
  const r = enablePluginInSettings(raw);
  expect(r.status).toBe("malformed");
  expect(r.content).toBe(raw);
});

test("runInit enables the plugin in .claude/settings.json by default, merge-safe", async () => {
  const dir = tmpRepo({ "package.json": JSON.stringify({ scripts: { test: "echo t" } }) });
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ model: "opus" }));

  const r = await runInit(dir);
  expect(r.pluginEnabled).toBe("added");
  const s = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
  expect(s.model).toBe("opus"); // preserved
  expect(s.enabledPlugins[PLUGIN_ID]).toBe(true);

  // idempotent: a second init reports "already" and doesn't rewrite
  const r2 = await runInit(dir);
  expect(r2.pluginEnabled).toBe("already");
});

test("runInit --no-enable-plugin (enablePlugin:false) writes no settings file", async () => {
  const dir = tmpRepo({ "package.json": JSON.stringify({ scripts: { test: "echo t" } }) });
  const r = await runInit(dir, { enablePlugin: false });
  expect(r.pluginEnabled).toBe("skipped");
  expect(existsSync(join(dir, ".claude/settings.json"))).toBe(false);
});

// ---------------------------------------------------------------------------
// North-star brief seed (spec 4.1) — seedBriefIfAbsent / gatherBriefInputs / inferBriefDraft
// ---------------------------------------------------------------------------

test("seedBriefIfAbsent creates .thebashway/brief.ts and is idempotent (no inference I/O on re-run)", () => {
  const dir = tmpRepo({
    "package.json": JSON.stringify({ name: "demo", description: "A demo tool.", scripts: { test: "vitest" } }),
  });
  mkdirSync(join(dir, ".thebashway"), { recursive: true });
  const briefPath = join(dir, ".thebashway", "brief.ts");

  const first = seedBriefIfAbsent(dir, briefPath);
  expect(first.created).toBe(true);
  expect(existsSync(briefPath)).toBe(true);
  const mtime1 = statSync(briefPath).mtimeMs;
  const content1 = readFileSync(briefPath, "utf8");

  // The idempotent re-run must NOT rewrite the brief. We poison package.json so that IF the
  // re-seed re-gathered, the produced module COULD differ; the byte-identical + unchanged-mtime
  // assertions below prove the file is NOT REWRITTEN. (Note: gatherBriefInputs tolerates garbage
  // JSON and leaves defaults, so this proves "not rewritten", not "not called" — the explicit
  // no-spawn spy in the next test proves gatherBriefInputs is not CALLED on the re-seed.)
  writeFileSync(join(dir, "package.json"), "GARBAGE not json", "utf8");
  const second = seedBriefIfAbsent(dir, briefPath);
  expect(second.created).toBe(false);
  expect(second.gaps).toEqual([]);
  expect(readFileSync(briefPath, "utf8")).toBe(content1); // byte-identical (not rewritten)
  expect(statSync(briefPath).mtimeMs).toBe(mtime1); // not rewritten
});

test("the idempotent re-seed does ZERO inference I/O: no `git log` spawn (genuine no-spawn spy)", () => {
  // gatherBriefInputs is the ONLY path that spawns `git log --oneline -20`. seedBriefIfAbsent guards
  // the gather behind !existsSync, so the idempotent re-seed must not reach it. We prove this with a
  // real spy on child_process.spawnSync (observed by init.ts's bare spawnSync call) and assert ZERO
  // `git log` spawns occur during the second seed — making the no-extra-I/O claim a spy, not a comment.
  const dir = tmpRepo({
    "package.json": JSON.stringify({ name: "demo", description: "A demo tool.", scripts: { test: "bun test" } }),
  });
  const briefPath = join(dir, ".thebashway", "brief.ts");
  mkdirSync(join(dir, ".thebashway"), { recursive: true });

  const spy = spyOn(childProcess, "spawnSync");
  try {
    // first seed CREATES the brief and DOES gather (>=1 `git log` spawn expected here)
    const first = seedBriefIfAbsent(dir, briefPath);
    expect(first.created).toBe(true);
    const isGitLog = (c: unknown[]) =>
      c[0] === "git" && Array.isArray(c[1]) && (c[1] as string[]).join(" ").includes("log --oneline");
    expect(spy.mock.calls.filter(isGitLog).length).toBe(1); // create path gathered

    spy.mockClear();
    // idempotent re-seed: short-circuits on !existsSync BEFORE gatherBriefInputs => zero git-log spawns
    const second = seedBriefIfAbsent(dir, briefPath);
    expect(second.created).toBe(false);
    expect(spy.mock.calls.filter(isGitLog).length).toBe(0); // NO re-gather: zero inference I/O
  } finally {
    spy.mockRestore();
  }
});

test("gatherBriefInputs reads the repo signals it claims (name/description/scripts/README)", () => {
  // The create-path inference is only meaningful if gatherBriefInputs actually reads its signals.
  const dir = tmpRepo({
    "package.json": JSON.stringify({ name: "widgetry", description: "Make widgets.", scripts: { test: "bun test", build: "next build" } }),
    "README.md": "# Widgetry\n\nWidgetry builds widgets for everyone.\n",
  });
  const inputs = gatherBriefInputs(dir);
  expect(inputs.name).toBe("widgetry");
  expect(inputs.description).toBe("Make widgets.");
  expect(inputs.scripts.test).toBe("bun test");
  expect(inputs.scripts.build).toBe("next build");
  expect(inputs.readmeFirstPara).toBe("Widgetry builds widgets for everyone.");
});

test("inferBriefDraft pre-fills purpose from a fixture README/package.json + records # GAPs", () => {
  const inputs = gatherBriefInputs(
    tmpRepo({
      "package.json": JSON.stringify({ name: "demo", description: "Ship the thing.", scripts: { test: "bun test" } }),
      "README.md": "# Demo\n\nDemo ships the thing to people.\n",
    }),
  );
  const { module, gaps } = inferBriefDraft(inputs);
  // purpose came from the package.json description
  expect(module).toContain("Ship the thing.");
  // un-inferred sections are recorded as # GAPs
  expect(gaps.some((g) => /# GAP: why now/.test(g))).toBe(true);
  expect(gaps.some((g) => /# GAP: who is served/.test(g))).toBe(true);
  // the unfilled success command is always a gap (an expected cold-start state)
  expect(gaps.some((g) => /success command/i.test(g))).toBe(true);
});

test("inferBriefDraft seeds conventions from a fixture scripts block (a test script => a testing-norm bullet)", () => {
  const inputs = gatherBriefInputs(
    tmpRepo({
      "package.json": JSON.stringify({ name: "x", scripts: { test: "bun test", build: "tsc" } }),
      "bun.lock": "",
    }),
  );
  const { module } = inferBriefDraft(inputs);
  // a test script => a testing-norm convention bullet mentioning the runner-prefixed invocation
  expect(module).toContain("Tests run via");
  expect(module).toContain("bun run test");
  // a build script => a build/land norm bullet
  expect(module).toContain("Build/land norm");
});

test("inferBriefDraft records # GAP: glossary when no confident domain term is found", () => {
  // name is lowercase generic, no README, no proper-noun-ish description tokens => no glossary term
  const inputs = gatherBriefInputs(
    tmpRepo({ "package.json": JSON.stringify({ name: "app", description: "a tiny cli", scripts: { test: "bun test" } }) }),
  );
  const { module, gaps } = inferBriefDraft(inputs);
  expect(gaps.some((g) => /# GAP: glossary/.test(g))).toBe(true);
  expect(module).toContain("# GAP: glossary");
});

test("empty-repo seed => BRIEF_SEED loads but is NOT trivially terminable", async () => {
  // an empty repo (no package.json, no README, no git history that betrays anything)
  const dir = mkdtempSync(join(tmpdir(), "tbw-empty-"));
  mkdirSync(join(dir, ".thebashway"), { recursive: true });
  const briefPath = join(dir, ".thebashway", "brief.ts");
  const seeded = seedBriefIfAbsent(dir, briefPath);
  expect(seeded.created).toBe(true);

  // it LOADS (the .refine() is satisfied by the required `command` placeholder slot)
  const loaded = await loadBrief(briefPath);
  expect(loaded.status).toBe("ok");
  expect(loaded.brief).not.toBeNull();
  // NOT trivially terminable: the required command criterion's run fails until a human edits it,
  // and the verify criterion is required:false (cannot alone terminate).
  const crits = loaded.brief!.successCriteria;
  const requiredCommand = crits.find((c) => c.required && c.check.kind === "command");
  expect(requiredCommand).toBeDefined();
  expect(requiredCommand!.check.kind === "command" && requiredCommand!.check.run).toContain("REPLACE-ME");
  const verify = crits.find((c) => c.check.kind === "verify");
  expect(verify?.required).toBe(false);
  expect(loaded.brief!.confirmed).toBe(false);
});

test("runInit populates InitResult.briefCreated/briefGaps and initMessage mentions `thebashway brief`", async () => {
  const dir = tmpRepo({ "package.json": JSON.stringify({ name: "demo", scripts: { test: "echo t" } }) });
  const r: InitResult = await runInit(dir);
  expect(r.briefCreated).toBe(true);
  expect(r.briefGaps.length).toBeGreaterThan(0);
  expect(existsSync(join(dir, ".thebashway/brief.ts"))).toBe(true);
  expect(initMessage(r)).toContain("thebashway brief");

  // idempotent re-run does not re-create the brief
  const r2 = await runInit(dir);
  expect(r2.briefCreated).toBe(false);
});
