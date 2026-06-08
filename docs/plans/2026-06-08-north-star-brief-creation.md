# North Star Brief Creation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make creating a north-star brief easy: a validated-JSON writer Claude calls (no hand-editing TS), a resumable save-as-you-go interview, and an on-by-default-overridable brief-first gate on the work commands.

**Architecture:** A pure `gapsOf` readiness reader (in the engine's `brief.ts`) is the single source of truth shared by the status command, the gate, and the writer. A new human-present `brief-writer.ts` holds the writer (`writeConfirmedBrief`), the JSON-payload parser, the pure gate decision, and the status formatter. `cli.ts` wires a `brief write` subcommand and a gate on `cmdFix`/`cmdBuild`/`cmdRunToGoal`. INV-A is preserved: the engine `brief.ts` stays writer-free; the only `writeFileSync(briefPath)` calls are `seedBriefIfAbsent` (init) and `writeConfirmedBrief`.

**Tech Stack:** Bun + TypeScript, `bun:test`, zod. Green gate is `bun test` only (do NOT add `bunx tsc` to a verify chain; run `bunx tsc --noEmit` by hand and ignore TS2688/bun-type noise). No emojis; ISO dates.

**Spec:** `docs/specs/2026-06-08-north-star-brief-creation-design.md`.

---

## File structure

| File | Responsibility | Create/Modify |
|---|---|---|
| `src/engine/brief.ts` | + `gapsOf(brief) → BriefReadiness` (pure reader). | Modify |
| `src/brief-writer.ts` | The human-present brief-command layer: `renderBriefModule` (pure), `writeConfirmedBrief` (IO write), `parseBriefWritePayload` (pure parse+validate+confirm-guard), `briefGateDecision` (pure), `briefStatusLines` (pure). | **Create** |
| `src/cli.ts` | `cmdBriefWrite` + `brief write` dispatch; the gate on `cmdFix`/`cmdBuild`/`cmdRunToGoal` + `--skip-brief`; richer `cmdBrief` status. | Modify |
| `src/binding.ts` | `RailsBinding.requireBrief?` resolved-with-default `true`. | Modify |
| `src/engine/config.ts` | `getRequireBrief()` accessor (set/reset). | Modify |
| `src/init.ts` | export `briefModule` (reuse by the writer); align gap wording to `gapsOf`; `initMessage` funnels into the interview. | Modify |
| `plugins/thebashway/skill/SKILL.md` | interview tightened: write-command, save-as-you-go, translate-obvious-defer-rest, read-back, gate funnel. | Modify |
| `thebashway.config.ts`, `examples/*.config.ts` | `requireBrief: false` (rails) so self-build + examples are not gated. | Modify |
| Tests | `src/engine/verify/__tests__/brief.test.ts`, `src/__tests__/brief-writer.test.ts` (new), `src/__tests__/binding.test.ts`, `src/__tests__/portability.test.ts`, `src/__tests__/init.test.ts` | Modify/Create |

Build order: Task 1 (`gapsOf`) → 2 (writer) → 3 (`brief write`) → 4 (`requireBrief`) → 5 (gate) → 6 (status) → 7 (init alignment) → 8 (SKILL) → 9 (configs) → 10 (integration).

---

## Task 1: `gapsOf` readiness reader (pure)

**Files:**
- Modify: `src/engine/brief.ts` (add after `classifyDrift`)
- Test: `src/engine/verify/__tests__/brief.test.ts`

Context — `DesignBrief` core fields are `purpose, whoServed, scope, limits` (Ring-1 core; `whyNow` is optional). The seeded success command's `run` is the literal `"echo REPLACE-ME && exit 1"`.

- [ ] **Step 1: Write the failing test** — append to `brief.test.ts`:

```ts
import { gapsOf } from "../../brief";
// helper: a minimal valid brief (the schema requires >=1 required command criterion)
function brief(over: Record<string, unknown> = {}) {
  return DesignBriefSchema.parse({
    purpose: "p", whyNow: "", whoServed: "w", scope: "s", limits: "l",
    successCriteria: [{ id: "c", statement: "s", check: { kind: "command", run: "bun test" }, required: true }],
    ...over,
  });
}

test("gapsOf: a filled confirmed brief is complete + autonomous-ready", () => {
  const r = gapsOf(brief({ confirmed: true }));
  expect(r.gaps).toEqual([]);
  expect(r.coreComplete).toBe(true);
  expect(r.autonomousReady).toBe(true);
  expect(r.confirmed).toBe(true);
});

test("gapsOf: empty Ring-1 core fields become gaps; whyNow does NOT", () => {
  const r = gapsOf(brief({ purpose: "", scope: "", whyNow: "" }));
  expect(r.coreComplete).toBe(false);
  expect(r.gaps).toContain("purpose");
  expect(r.gaps).toContain("scope");
  expect(r.gaps).not.toContain("why now");
});

test("gapsOf: the REPLACE-ME command placeholder => not autonomous-ready (a gap), still core-complete", () => {
  const r = gapsOf(brief({ successCriteria: [
    { id: "c", statement: "s", check: { kind: "command", run: "echo REPLACE-ME && exit 1" }, required: true },
  ] }));
  expect(r.coreComplete).toBe(true);
  expect(r.autonomousReady).toBe(false);
  expect(r.gaps).toContain("success check");
});
```

- [ ] **Step 2: Run it, verify it fails** — `bun test src/engine/verify/__tests__/brief.test.ts` → FAIL ("gapsOf is not a function").

- [ ] **Step 3: Implement `gapsOf`** in `src/engine/brief.ts` (after `classifyDrift`, before any non-pure code — it stays pure, no fs):

```ts
export interface BriefReadiness {
  gaps: string[];           // plain-language labels of what's still missing
  coreComplete: boolean;    // Ring-1 core (purpose/whoServed/scope/limits) all non-empty
  autonomousReady: boolean; // a required command criterion exists whose run is not the REPLACE-ME placeholder
  confirmed: boolean;       // mirrors brief.confirmed
}

const PLACEHOLDER_RUN = "echo REPLACE-ME && exit 1";

/** Deterministic readiness of a brief — the single source of truth for the status command,
 * the brief-first gate, and the writer's gap recompute. Pure (no fs/spawn). */
export function gapsOf(brief: DesignBrief): BriefReadiness {
  const gaps: string[] = [];
  if (!brief.purpose.trim()) gaps.push("purpose");
  if (!brief.whoServed.trim()) gaps.push("who it's for");
  if (!brief.scope.trim()) gaps.push("scope");
  if (!brief.limits.trim()) gaps.push("what's out of scope");
  const coreComplete = gaps.length === 0;
  const autonomousReady = brief.successCriteria.some(
    (c) => c.required && c.check.kind === "command" && c.check.run.trim() !== PLACEHOLDER_RUN,
  );
  if (!autonomousReady) gaps.push("success check");
  return { gaps, coreComplete, autonomousReady, confirmed: brief.confirmed };
}
```

- [ ] **Step 4: Run tests, verify pass** — `bun test src/engine/verify/__tests__/brief.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/brief.ts src/engine/verify/__tests__/brief.test.ts
git commit -m "north-star brief creation: gapsOf readiness reader (pure)"
```

---

## Task 2: the writer — `renderBriefModule` + `writeConfirmedBrief`

**Files:**
- Modify: `src/init.ts` (export the existing `briefModule` renderer for reuse)
- Create: `src/brief-writer.ts`
- Test: `src/__tests__/brief-writer.test.ts`

Context — `init.ts` already has a `briefModule(fields)` function that renders the `export default { … }` module text from a fields object whose keys are the `DesignBrief` fields. Reuse it (DRY) rather than writing a second renderer.

- [ ] **Step 1: Export `briefModule`** — in `src/init.ts`, add `export` to the existing `function briefModule(` declaration (find it near line 176; change `function briefModule` → `export function briefModule`).

- [ ] **Step 2: Write the failing test** — `src/__tests__/brief-writer.test.ts`:

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfirmedBrief, renderBriefModule } from "../brief-writer";
import { DesignBriefSchema, type DesignBrief } from "../engine/brief";
import { loadBrief } from "../engine/load-brief";

function full(over: Record<string, unknown> = {}): DesignBrief {
  return DesignBriefSchema.parse({
    confirmed: true, purpose: "ship widgets", whoServed: "owners", scope: "the widget core", limits: "no billing",
    conventions: ["npm"], glossary: [{ term: "Widget", means: "a thing" }], gaps: ["stale"],
    successCriteria: [{ id: "tests", statement: "tests pass", check: { kind: "command", run: "bun test" }, required: true }],
    ...over,
  });
}

test("writeConfirmedBrief writes a file that round-trips through loadBrief to status:ok", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bw-"));
  const path = join(dir, "brief.ts");
  writeConfirmedBrief(full(), path);
  const loaded = await loadBrief(path);
  expect(loaded.status).toBe("ok");
  expect(loaded.brief?.confirmed).toBe(true);
  expect(loaded.brief?.purpose).toBe("ship widgets");
  rmSync(dir, { recursive: true, force: true });
});

test("writeConfirmedBrief recomputes gaps via gapsOf (ignores caller's stale gaps)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bw-"));
  const path = join(dir, "brief.ts");
  writeConfirmedBrief(full({ gaps: ["WRONG", "STALE"] }), path); // caller's gaps are stale
  const loaded = await loadBrief(path);
  expect(loaded.brief?.gaps).not.toContain("WRONG"); // recomputed: a complete brief has no gaps
  expect(loaded.brief?.gaps).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test("renderBriefModule is pure (same input → same output)", () => {
  const b = full();
  expect(renderBriefModule(b)).toBe(renderBriefModule(b));
});
```

- [ ] **Step 3: Run it, verify it fails** — `bun test src/__tests__/brief-writer.test.ts` → FAIL ("Cannot find module ../brief-writer").

- [ ] **Step 4: Implement `src/brief-writer.ts`** (the writer + render only for this task; the parse/gate/status helpers land in Tasks 3 & 5):

```ts
// src/brief-writer.ts
// The human-present brief-command layer. INV-A: writeConfirmedBrief is the SECOND of the two
// sanctioned writers (the first is init.ts's seedBriefIfAbsent). The engine's brief.ts exports
// no writer; this is the only non-init writeFileSync(briefPath) in the codebase.
import { writeFileSync } from "node:fs";
import { gapsOf, type DesignBrief } from "./engine/brief";
import { briefModule } from "./init";

/** Pure render of a confirmed DesignBrief to a clean, re-readable brief.ts module. */
export function renderBriefModule(brief: DesignBrief): string {
  // gaps are recomputed canonically (never trust a caller's stale list).
  const fields = { ...brief, gaps: gapsOf(brief).gaps };
  return briefModule(fields);
}

/** The human-present write. Renders + writes; recomputes gaps via gapsOf. */
export function writeConfirmedBrief(brief: DesignBrief, briefPath: string): void {
  writeFileSync(briefPath, renderBriefModule(brief), "utf8");
}
```

Note: `gapsOf` returns plain-language labels (e.g. `"purpose"`); the persisted `gaps` array therefore holds those labels, which is what `cmdBrief`/the gate display. If `briefModule`'s field shape rejects extra keys, map explicitly: pass only the `DesignBrief` keys plus the recomputed `gaps`.

- [ ] **Step 5: Run tests, verify pass** — `bun test src/__tests__/brief-writer.test.ts` → PASS. Then `bun test` (full) → all green.

- [ ] **Step 6: Commit**

```bash
git add src/brief-writer.ts src/init.ts src/__tests__/brief-writer.test.ts
git commit -m "north-star brief creation: writeConfirmedBrief writer (reuses init briefModule)"
```

---

## Task 3: `parseBriefWritePayload` + `cmdBriefWrite` + dispatch

**Files:**
- Modify: `src/brief-writer.ts` (add `parseBriefWritePayload`)
- Modify: `src/cli.ts` (`cmdBriefWrite` + `brief write` dispatch)
- Test: `src/__tests__/brief-writer.test.ts`

- [ ] **Step 1: Write the failing test** for the pure parser — append to `brief-writer.test.ts`:

```ts
import { parseBriefWritePayload } from "../brief-writer";

test("parseBriefWritePayload rejects malformed JSON", () => {
  const r = parseBriefWritePayload("{ not json");
  expect(r.ok).toBe(false);
});

test("parseBriefWritePayload rejects a schema-invalid payload (no required command criterion)", () => {
  const r = parseBriefWritePayload(JSON.stringify({
    purpose: "p", whyNow: "", whoServed: "w", scope: "s", limits: "l",
    successCriteria: [{ id: "v", statement: "verify", check: { kind: "verify" }, required: true }],
  }));
  expect(r.ok).toBe(false);
});

test("parseBriefWritePayload allows a partial draft (confirmed:false, empty core)", () => {
  const r = parseBriefWritePayload(JSON.stringify({
    confirmed: false, purpose: "", whyNow: "", whoServed: "", scope: "", limits: "",
    successCriteria: [{ id: "c", statement: "s", check: { kind: "command", run: "echo REPLACE-ME && exit 1" }, required: true }],
  }));
  expect(r.ok).toBe(true);
});

test("parseBriefWritePayload REFUSES confirmed:true while a Ring-1 core field is empty", () => {
  const r = parseBriefWritePayload(JSON.stringify({
    confirmed: true, purpose: "p", whyNow: "", whoServed: "", scope: "s", limits: "l",
    successCriteria: [{ id: "c", statement: "s", check: { kind: "command", run: "bun test" }, required: true }],
  }));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.join(" ")).toMatch(/who it's for/i);
});

test("parseBriefWritePayload ALLOWS confirmed:true with the deferred success placeholder", () => {
  const r = parseBriefWritePayload(JSON.stringify({
    confirmed: true, purpose: "p", whyNow: "", whoServed: "w", scope: "s", limits: "l",
    successCriteria: [{ id: "c", statement: "s", check: { kind: "command", run: "echo REPLACE-ME && exit 1" }, required: true }],
  }));
  expect(r.ok).toBe(true);
});
```

- [ ] **Step 2: Run it, verify it fails** — `bun test src/__tests__/brief-writer.test.ts -t parseBriefWritePayload` → FAIL.

- [ ] **Step 3: Implement `parseBriefWritePayload`** in `src/brief-writer.ts`:

```ts
import { DesignBriefSchema } from "./engine/brief";

export type BriefWriteParse =
  | { ok: true; brief: DesignBrief }
  | { ok: false; errors: string[] };

/** Parse + validate a `brief write` JSON payload at the boundary. Rejects malformed JSON, a
 * schema-invalid brief, and a premature confirm (confirmed:true while a Ring-1 core field is empty).
 * The deferred success-command placeholder is the ONE gap allowed under confirmed:true. */
export function parseBriefWritePayload(raw: string): BriefWriteParse {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: [`payload is not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const parsed = DesignBriefSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const brief = parsed.data;
  if (brief.confirmed) {
    const readiness = gapsOf(brief);
    if (!readiness.coreComplete) {
      const missing = readiness.gaps.filter((g) => g !== "success check");
      return { ok: false, errors: [`cannot confirm — these core fields are still empty: ${missing.join(", ")}`] };
    }
  }
  return { ok: true, brief };
}
```

- [ ] **Step 4: Run tests, verify pass** — `bun test src/__tests__/brief-writer.test.ts` → PASS.

- [ ] **Step 5: Add `cmdBriefWrite` to `src/cli.ts`** (import `readFileSync` from `node:fs` at top if absent; import the helpers):

```ts
// add to the existing imports
import { writeConfirmedBrief, parseBriefWritePayload } from "./brief-writer";
import { readFileSync } from "node:fs";

/** `thebashway brief write --from <file>`: validate a JSON payload at the boundary and write the
 * brief. The agent-facing writer behind the conversational interview (it never hand-edits brief.ts). */
async function cmdBriefWrite(cwd: string, args: string[], configPath?: string): Promise<number> {
  const fromIdx = args.indexOf("--from");
  const file = fromIdx >= 0 ? args[fromIdx + 1] : args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("brief write: pass the payload with --from <file>");
    return 2;
  }
  const lb = await loadBinding({ cwd, configPath });
  const raw = readFileSync(resolve(cwd, file), "utf8");
  const parsed = parseBriefWritePayload(raw);
  if (!parsed.ok) {
    console.error(`brief write rejected (nothing written):\n  - ${parsed.errors.join("\n  - ")}`);
    return 1;
  }
  writeConfirmedBrief(parsed.brief, lb.paths.briefPath);
  const r = gapsOf(parsed.brief);
  console.log(
    `Wrote ${lb.paths.briefPath} — ${r.confirmed ? "confirmed" : "draft"}` +
      `${r.gaps.length ? `, remaining: ${r.gaps.join(", ")}` : ", no gaps"}` +
      `${r.autonomousReady ? "" : " (success check not set — autonomous-to-goal stays off until it is)"}`,
  );
  return 0;
}
```

Add the `gapsOf` import to cli.ts if absent: `import { gapsOf } from "./engine/brief";` (or extend the existing `./engine/brief` import).

- [ ] **Step 6: Route `brief write` in `main()`** — change the `brief` case:

```ts
    case "brief":
      return args[0] === "write" ? cmdBriefWrite(cwd, args.slice(1), configPath) : cmdBrief(cwd, args, configPath);
```

- [ ] **Step 7: Smoke it** — Run:

```bash
cd /tmp && rm -rf bw-smoke && mkdir bw-smoke && cd bw-smoke && git init -q
printf 'import { defineThebashway } from "/Users/bachir.habib/projects/thebashway/src/binding";\nexport default defineThebashway({ repoRoot: import.meta.dir, defaultSurface: "app", surfaces: { app: { dir: ".", role: "x", chain: [{ name: "t", cmd: ["bun","test"] }] } }, rails: { territoryGlobs: [], keywords: /x/ }, learning: { global: null, local: ".thebashway/lessons.md", decisions: ".thebashway/decisions.md", brief: ".thebashway/brief.ts" } });\n' > thebashway.config.ts
mkdir -p .thebashway && touch .thebashway/lessons.md .thebashway/decisions.md
printf '{"confirmed":true,"purpose":"ship","whoServed":"me","scope":"core","limits":"none","successCriteria":[{"id":"t","statement":"tests pass","check":{"kind":"command","run":"bun test"},"required":true}]}' > /tmp/answers.json
bun run /Users/bachir.habib/projects/thebashway/src/cli.ts brief write --from /tmp/answers.json
cat .thebashway/brief.ts | head -8
cd /Users/bachir.habib/projects/thebashway
```
Expected: "Wrote …/brief.ts — confirmed, no gaps"; the file shows `confirmed: true`.

- [ ] **Step 8: Run full suite + commit**

```bash
bun test   # all green
git add src/cli.ts src/brief-writer.ts src/__tests__/brief-writer.test.ts
git commit -m "north-star brief creation: brief write --from <file> (validated-JSON writer command)"
```

---

## Task 4: `requireBrief` binding flag + `getRequireBrief` accessor

**Files:**
- Modify: `src/binding.ts` (`RailsBinding` + the `defineThebashway` rails spread)
- Modify: `src/engine/config.ts` (`getRequireBrief` + set/reset)
- Test: `src/__tests__/binding.test.ts`, `src/__tests__/portability.test.ts`

- [ ] **Step 1: Write the failing tests** — in `binding.test.ts` add:

```ts
test("defineThebashway defaults requireBrief to true without the learning guard throwing", () => {
  const r = defineThebashway(minimalBinding()); // the existing minimal fixture helper
  expect(r.rails.requireBrief).toBe(true);
});
test("requireBrief:false is preserved", () => {
  const r = defineThebashway({ ...minimalBinding(), rails: { territoryGlobs: [], keywords: /x/, requireBrief: false } });
  expect(r.rails.requireBrief).toBe(false);
});
```

In `portability.test.ts`, beside the existing `getBriefSensitivity` set/reset assertions, add:

```ts
import { getRequireBrief } from "../engine/config";
// after setBinding(...) with a requireBrief:false binding:
expect(getRequireBrief()).toBe(false);
// after resetBinding():
expect(getRequireBrief()).toBe(true);
```

(Match the file's existing `minimalBinding`/fixture helper names; if `minimalBinding` does not exist, inline the `minimal` fixture the file already uses.)

- [ ] **Step 2: Run, verify fail** — `bun test src/__tests__/binding.test.ts` → FAIL (`requireBrief` undefined / `getRequireBrief` missing).

- [ ] **Step 3: Add to `RailsBinding`** (`src/binding.ts`, after `briefDriftSensitivity`):

```ts
  /** When true (default), the work commands (build/fix/run-to-goal) require a CONFIRMED brief
   * before they run; otherwise they guide the owner into the interview. Set false for
   * headless/scheduled runs or a repo that opts out. Per-run override: --skip-brief. */
  requireBrief?: boolean;
```

- [ ] **Step 4: Resolve the default in the `defineThebashway` rails spread** — in the return object, extend the existing `rails: { ...b.rails, briefDriftSensitivity: … }` to also set `requireBrief: b.rails.requireBrief ?? true`. Do NOT touch the `:140` learning throw guard.

- [ ] **Step 5: Add the config accessor** (`src/engine/config.ts`): beside `_briefSensitivity` add `let _requireBrief = true;`; add:

```ts
/** Whether work commands require a confirmed brief (binding.rails.requireBrief). Default true. */
export function getRequireBrief(): boolean {
  return _requireBrief;
}
```

In `setBinding`: `_requireBrief = b.rails.requireBrief ?? true;`. In `resetBinding`: `_requireBrief = true;`.

- [ ] **Step 6: Run tests, verify pass** — `bun test src/__tests__/binding.test.ts src/__tests__/portability.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/binding.ts src/engine/config.ts src/__tests__/binding.test.ts src/__tests__/portability.test.ts
git commit -m "north-star brief creation: requireBrief binding flag + getRequireBrief accessor (default true)"
```

---

## Task 5: the gate — `briefGateDecision` (pure) + cli wiring

**Files:**
- Modify: `src/brief-writer.ts` (`briefGateDecision`)
- Modify: `src/cli.ts` (a `briefGate` helper + calls in `cmdFix`/`cmdBuild`/`cmdRunToGoal` + `--skip-brief`)
- Test: `src/__tests__/brief-writer.test.ts`

- [ ] **Step 1: Write the failing test** — append to `brief-writer.test.ts`:

```ts
import { briefGateDecision } from "../brief-writer";

test("gate passes when requireBrief is off, or skipped, or confirmed", () => {
  expect(briefGateDecision({ status: "absent", confirmed: false, requireBrief: false, skipBrief: false }).pass).toBe(true);
  expect(briefGateDecision({ status: "absent", confirmed: false, requireBrief: true, skipBrief: true }).pass).toBe(true);
  expect(briefGateDecision({ status: "ok", confirmed: true, requireBrief: true, skipBrief: false }).pass).toBe(true);
});

test("gate stops with a guided message when no confirmed brief", () => {
  const absent = briefGateDecision({ status: "absent", confirmed: false, requireBrief: true, skipBrief: false });
  expect(absent.pass).toBe(false);
  expect(absent.message).toMatch(/north star isn.t set up/i);

  const draft = briefGateDecision({
    status: "ok", confirmed: false, requireBrief: true, skipBrief: false,
    readiness: { gaps: ["scope", "success check"], coreComplete: false, autonomousReady: false, confirmed: false },
  });
  expect(draft.pass).toBe(false);
  expect(draft.message).toMatch(/in progress/i);
  expect(draft.message).toMatch(/scope/);
});

test("gate surfaces the unparseable loud signal", () => {
  const r = briefGateDecision({ status: "unparseable", confirmed: false, requireBrief: true, skipBrief: false });
  expect(r.pass).toBe(false);
  expect(r.message).toMatch(/does not parse/i);
});
```

- [ ] **Step 2: Run, verify fail** — `bun test src/__tests__/brief-writer.test.ts -t gate` → FAIL.

- [ ] **Step 3: Implement `briefGateDecision`** in `src/brief-writer.ts`:

```ts
import type { BriefReadiness } from "./engine/brief";

export function briefGateDecision(opts: {
  status: "ok" | "absent" | "unparseable";
  confirmed: boolean;
  readiness?: BriefReadiness;
  requireBrief: boolean;
  skipBrief: boolean;
}): { pass: boolean; message?: string } {
  if (!opts.requireBrief || opts.skipBrief) return { pass: true };
  if (opts.status === "ok" && opts.confirmed) return { pass: true };
  if (opts.status === "unparseable") {
    return { pass: false, message: "Your north star file exists but does not parse — fix it before continuing (or pass --skip-brief)." };
  }
  if (opts.status === "ok" && !opts.confirmed) {
    const gaps = opts.readiness?.gaps ?? [];
    const left = gaps.length ? ` (still to do: ${gaps.join(", ")})` : "";
    return { pass: false, message: `Your north star is in progress${left}. Finish it first: thebashway brief. (Or pass --skip-brief.)` };
  }
  return { pass: false, message: "Your north star isn't set up yet — let's do that first: thebashway brief. (Or pass --skip-brief / set requireBrief:false.)" };
}
```

- [ ] **Step 4: Run tests, verify pass** — `bun test src/__tests__/brief-writer.test.ts -t gate` → PASS.

- [ ] **Step 5: Add the `briefGate` helper to `cli.ts`** (does the IO + decision):

```ts
import { briefGateDecision } from "./brief-writer";
import { getRequireBrief } from "./engine/config";

/** Brief-first gate: load the brief and decide whether a work command may run. */
async function briefGate(lb: LoadedBinding, args: string[]): Promise<{ pass: boolean; message?: string }> {
  const skipBrief = args.includes("--skip-brief");
  const loaded = await loadBrief(lb.paths.briefPath);
  const readiness = loaded.status === "ok" && loaded.brief ? gapsOf(loaded.brief) : undefined;
  return briefGateDecision({
    status: loaded.status,
    confirmed: loaded.brief?.confirmed ?? false,
    readiness,
    requireBrief: getRequireBrief(),
    skipBrief,
  });
}
```

- [ ] **Step 6: Wire the gate into the three work commands.** In `cmdFix`, `cmdBuild`, and `cmdRunToGoal`, immediately AFTER `const lb = await loadBinding(...)` insert:

```ts
  const gate = await briefGate(lb, args);
  if (!gate.pass) { console.error(gate.message); return 1; }
```

(For `cmdRunToGoal`, `args` is in scope; for `cmdBuild`/`cmdFix` it is the `args` param.) The bare-request default in `main()` routes through `cmdBuild`/`cmdFix`, so it inherits the gate. Do NOT gate `cmdBrief`, `cmdBriefWrite`, `cmdAuditPlan`, `cmdInit`, `cmdReflect`, `cmdCheckSync`, `cmdUpdate`.

- [ ] **Step 7: Smoke the gate** — Run (reusing the `/tmp/bw-smoke` repo from Task 3, but first remove the brief so it's absent):

```bash
cd /tmp/bw-smoke && rm -f .thebashway/brief.ts
bun run /Users/bachir.habib/projects/thebashway/src/cli.ts build "add a thing" ; echo "exit=$?"
# Expected: "Your north star isn't set up yet…", exit=1
bun run /Users/bachir.habib/projects/thebashway/src/cli.ts build "add a thing" --skip-brief 2>&1 | head -2 ; echo "(skip ran past the gate)"
cd /Users/bachir.habib/projects/thebashway
```
Expected: gated run prints the guided message + exit 1; `--skip-brief` proceeds past the gate.

- [ ] **Step 8: Full suite + commit**

```bash
bun test   # all green
git add src/cli.ts src/brief-writer.ts src/__tests__/brief-writer.test.ts
git commit -m "north-star brief creation: brief-first gate on build/fix/run-to-goal (--skip-brief override)"
```

---

## Task 6: richer `thebashway brief` status

**Files:**
- Modify: `src/brief-writer.ts` (`briefStatusLines`)
- Modify: `src/cli.ts` (`cmdBrief` uses it)
- Test: `src/__tests__/brief-writer.test.ts`

- [ ] **Step 1: Write the failing test** — append:

```ts
import { briefStatusLines } from "../brief-writer";

test("briefStatusLines: confirmed + ready → 'you're set'", () => {
  const lines = briefStatusLines({ gaps: [], coreComplete: true, autonomousReady: true, confirmed: true }).join("\n");
  expect(lines).toMatch(/confirmed/i);
  expect(lines).toMatch(/set/i);
});
test("briefStatusLines: draft → shows remaining gaps + the next step", () => {
  const lines = briefStatusLines({ gaps: ["scope", "success check"], coreComplete: false, autonomousReady: false, confirmed: false }).join("\n");
  expect(lines).toMatch(/draft/i);
  expect(lines).toMatch(/scope/);
  expect(lines).toMatch(/interview/i);
});
```

- [ ] **Step 2: Run, verify fail** → FAIL.

- [ ] **Step 3: Implement `briefStatusLines`** in `src/brief-writer.ts`:

```ts
export function briefStatusLines(r: BriefReadiness): string[] {
  if (r.confirmed && r.autonomousReady) return ["North star: confirmed — you're all set."];
  if (r.confirmed) return ["North star: confirmed (success check not set — fill it to enable hands-off autonomous-to-goal runs)."];
  const left = r.gaps.length ? ` Still to do: ${r.gaps.join(", ")}.` : "";
  return [`North star: draft — not confirmed yet.${left}`, "Next: run the brief interview with the agent (it asks plain questions and writes it for you)."];
}
```

- [ ] **Step 4: Use it in `cmdBrief`** — replace the gap-printing block (lines ~172-178) with:

```ts
  if (loaded.status === "unparseable") {
    console.log(`! Brief exists but does not parse (${loaded.errors.join("; ")}). Fix it before the interview.`);
    return 1;
  }
  const readiness = loaded.brief ? gapsOf(loaded.brief) : { gaps: seeded.gaps, coreComplete: false, autonomousReady: false, confirmed: false };
  for (const line of briefStatusLines(readiness)) console.log(line);
```

Add `briefStatusLines` to the `./brief-writer` import.

- [ ] **Step 5: Run tests + smoke** — `bun test`; then `bun run src/cli.ts brief` in the `/tmp/bw-smoke` repo shows the new status. PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/brief-writer.ts src/__tests__/brief-writer.test.ts
git commit -m "north-star brief creation: richer thebashway brief status (confirmed/gaps/autonomous-ready)"
```

---

## Task 7: align init gaps to `gapsOf` + funnel the init message

**Files:**
- Modify: `src/init.ts`
- Test: `src/__tests__/init.test.ts`

Goal — the seed's gap labels and `gapsOf`'s labels should describe the same things in the same words, so status/resume are consistent whether a brief was just seeded or loaded.

- [ ] **Step 1: Write the failing test** — in `init.test.ts`:

```ts
import { gapsOf } from "../engine/brief";
import { loadBrief } from "../engine/load-brief";
test("a freshly seeded brief's gapsOf matches the kinds of gaps init recorded", async () => {
  // seed into a temp dir (reuse the file's existing temp-repo helper), then:
  const loaded = await loadBrief(seededBriefPath);
  const r = gapsOf(loaded.brief!);
  // an empty-core seed is not core-complete and not autonomous-ready (placeholder command)
  expect(r.coreComplete).toBe(false);
  expect(r.autonomousReady).toBe(false);
  expect(r.gaps).toContain("success check");
});
```

- [ ] **Step 2: Run, verify fail/inconsistency** → if it fails, the seed produced a brief whose `gapsOf` disagrees with the recorded gaps.

- [ ] **Step 3: Reconcile** — ensure `inferBriefDraft`/`EMPTY_REPO_GAPS` produce a brief whose empty fields and placeholder command make `gapsOf` report the same missing core + "success check". (The labels in the persisted `gaps` array may stay descriptive; the test asserts `gapsOf` over the *loaded brief*, so the key is that the seeded *field values* — empty core, placeholder command — are what `gapsOf` reads. No code change may be needed beyond confirming; if `gapsOf` disagrees, adjust the seed field values, not `gapsOf`.)

- [ ] **Step 4: Funnel `initMessage`** — confirm/adjust the existing brief nudge to point explicitly at the interview, e.g.: `Run \`thebashway brief\` and the agent will walk you through setting up your north star — you can't build or fix until it's confirmed (or pass --skip-brief).`

- [ ] **Step 5: Run tests, verify pass** — `bun test src/__tests__/init.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/init.ts src/__tests__/init.test.ts
git commit -m "north-star brief creation: align init seed gaps to gapsOf + funnel initMessage into the interview"
```

---

## Task 8: tighten the SKILL.md interview

**Files:**
- Modify: `plugins/thebashway/skill/SKILL.md` (the north-star interview section, ~lines 51-102)

No automated test (doc). Edit the section to:

- [ ] **Step 1** — Replace the "until it ships, confirming is a hand-edit of brief.ts" fallback with: *On confirmation, call `thebashway brief write --from <file>` with the agreed fields as JSON (`confirmed: true`). It validates at the boundary and writes — never hand-edit `brief.ts`.*
- [ ] **Step 2** — Add **save-as-you-go**: *After each ring (or any pause), call `brief write --from <file>` with the fields gathered so far and `confirmed: false`. On resume, run `thebashway brief` to see remaining gaps and ask only those.*
- [ ] **Step 3** — Make the **success rule** crisp: *Map obvious answers ("tests pass" → the verify chain / `bun test`; "the build is green" → the build command) to a `command`/`verify` check and read it back. Otherwise capture a plain `milestone` and leave the `echo REPLACE-ME && exit 1` placeholder — tell the owner it's an optional "make-it-autonomous-ready" step, never a blocker. Never ask the owner for a shell command.*
- [ ] **Step 4** — Add the **read-back** requirement and the **gate funnel** note (after `init`, the owner can't build/fix until the brief is confirmed; lead them straight into the interview).
- [ ] **Step 5: Commit**

```bash
git add plugins/thebashway/skill/SKILL.md
git commit -m "north-star brief creation: SKILL interview uses brief write, save-as-you-go, read-back, gate funnel"
```

---

## Task 9: opt the dogfood + examples out of the gate

**Files:**
- Modify: `thebashway.config.ts` (rails) and `examples/lifeofbash.config.ts`, `examples/nextjs-minimal.config.ts`
- Test: `src/__tests__/portability.test.ts`

- [ ] **Step 1: Write the failing test** — in `portability.test.ts`, assert the example bindings still resolve and that a `requireBrief:false` binding makes `getRequireBrief()` false (covered by Task 4's accessor test; here assert the example config files load without the gate forcing setup). Add:

```ts
test("nextjs-minimal example opts out of the brief gate", async () => {
  const mod = await import("../../examples/nextjs-minimal.config.ts");
  expect(mod.default.rails.requireBrief).toBe(false);
});
```

- [ ] **Step 2: Run, verify fail** → FAIL (requireBrief undefined on the example).

- [ ] **Step 3: Add `requireBrief: false`** to the `rails` block of `thebashway.config.ts`, `examples/lifeofbash.config.ts`, and `examples/nextjs-minimal.config.ts`. For the dogfood `thebashway.config.ts`, add a one-line comment: `// the engine builds itself headlessly; the brief gate is opt-out here (no human interview mid-self-build).`

- [ ] **Step 4: Run tests, verify pass** — `bun test src/__tests__/portability.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add thebashway.config.ts examples/lifeofbash.config.ts examples/nextjs-minimal.config.ts src/__tests__/portability.test.ts
git commit -m "north-star brief creation: opt the dogfood + example configs out of the brief gate"
```

---

## Task 10: integration verification

**Files:** none (verification only)

- [ ] **Step 1: Full suite** — `bun test` → all green (baseline 408 + the new tests).
- [ ] **Step 2: Type check** — `bunx tsc --noEmit 2>&1 | grep -iE "error TS" | grep -vE "TS2688|Cannot find type definition|@types/bun"` → no real errors.
- [ ] **Step 3: End-to-end live smoke** in a fresh temp repo (resolvable config like Task 3's): `init` → `brief` (shows draft + gaps) → `build` (gated, guided message, exit 1) → `brief write --from <partial answers, confirmed:false>` → `brief` (shows fewer gaps) → `brief write --from <full answers, confirmed:true>` → `brief` (shows "confirmed — you're set") → `build` (now passes the gate). Confirm each transition.
- [ ] **Step 4: INV-A check** — `grep -rn "writeFileSync\|Bun.write" src/engine/brief.ts` → empty; the only `writeFileSync(briefPath)` callers are `seedBriefIfAbsent` (init.ts) and `writeConfirmedBrief` (brief-writer.ts).
- [ ] **Step 5: Update docs** — add `thebashway brief write` and `--skip-brief` to USAGE.md's command table + the `requireBrief` rails field; note the brief-first gate in README's north-star section. Commit.

```bash
git add USAGE.md README.md
git commit -m "north-star brief creation: document brief write, --skip-brief, requireBrief, and the brief-first gate"
```

---

## Self-review notes (run after writing; fixed inline)

- **Spec coverage:** §4.1 gapsOf → T1; §4.2 writer+payload → T2,T3; §4.3 resumable (partial saves) → T3 (confirmed:false path) + T8 (save-as-you-go prose); §4.4 gate → T4,T5; §4.5 SKILL → T8; §4.6 status → T6; back-compat/dogfood → T9; init funnel → T7; docs → T10. All covered.
- **Type consistency:** `BriefReadiness` (T1) is the shape consumed by `briefGateDecision`/`briefStatusLines` (T5,T6) and returned by `gapsOf` everywhere. `writeConfirmedBrief(brief, path)` / `parseBriefWritePayload(raw)` / `briefGateDecision(opts)` signatures are stable across tasks.
- **No placeholders:** every code step carries real code; the one judgement step (T7 Step 3 reconcile) is explicit about what to check and which side to adjust.
- **Known approximation:** exact line numbers (cmdBrief ~172, briefModule ~176) are anchors — follow the real code; the gate insertion point is "right after `loadBinding`" in each of the three commands.
