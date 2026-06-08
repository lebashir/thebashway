---
created: 2026-06-08
status: design / ready for review
scope: feature (north-star brief CREATION UX — the writer, resumable interview, and the brief-first gate)
repo: ~/projects/thebashway
depends-on: 2026-06-07-north-star-design-brief.md (the north-star epic, BUILT) — this adds the missing creation experience
source: brainstorming dialogue with Bashir (4 forks resolved: conversational creation, translate-obvious-defer-rest, on-by-default-overridable gate, resumable)
---

# North Star — Brief Creation UX

**Status:** design / ready for review · **Scope:** one feature · **Repo:** `~/projects/thebashway`

## 1. Problem

The north-star epic shipped the brief's *schema*, *loading*, *guidance*, *termination*, and *reflection* — but **not a usable way to CREATE one**. Today:

- `thebashway init` drafts `.thebashway/brief.ts` full of `REPLACE-ME` placeholders + `# GAP`s, `confirmed: false`.
- `thebashway brief` prints the gaps and says "ask the agent to walk you through it."
- The three-ring interview is specified as agent prose in `SKILL.md` — but its final step has **no writer**: `writeConfirmedBrief` was named in the doctrine and never built, so SKILL.md literally falls back to *"confirming is a human-present edit of `brief.ts` (flipping `confirmed:true` by hand)."*

So a non-technical owner's path to a north star ends at **hand-editing a TypeScript file** — the opposite of easy. This feature closes that gap.

## 2. Decisions (resolved in brainstorming)

1. **Primary creation path = a conversation with Claude** (the agent-driven interview). The CLI cannot hold a conversation (every command is `cmd(cwd, args): Promise<number>`, no stdin); the agent asks, maps answers to the schema, and writes. (Rejected: a self-serve interactive terminal wizard; a fill-a-template file.)
2. **The writer = a validated-JSON CLI command** Claude calls, mirroring the established `enqueue-findings <file>` pattern (zod-validate at the boundary, atomic write). (Rejected: incremental `brief set field=…`; Claude hand-editing `brief.ts`.)
3. **Success criterion = translate-the-obvious, defer-the-rest.** Obvious answers ("tests pass," "the build is green") → Claude proposes a check and reads it back; fuzzy answers → captured as a plain human-judged goal, the runnable check left as a clearly-marked optional follow-up. The owner is **never** asked for a shell command.
4. **Brief-first gate = on by default, overridable.** The work commands stop and guide you into the interview when there's no confirmed brief; a binding flag (`requireBrief: false`) + a per-run `--skip-brief` escape hatch cover headless/scheduled runs, quick one-offs, and repos that decline. (Rejected: hard-no-escape; gate-only-new-repos.)
5. **Resumable.** Creation persists progress as it goes (partial saves, `confirmed: false`); pause anytime, resume asking only the remaining gaps.

## 3. Architecture overview

Four small pieces, one shared source of truth:

```
gapsOf(brief)            ← NEW pure reader in src/engine/brief.ts. "What is still missing /
   │                        is this autonomous-ready?" The ONE truth shared by all three below.
   ├─ thebashway brief            (status — what's done, what's left, the next step)
   ├─ the brief-first GATE        (work commands stop here when not confirmed, unless overridden)
   └─ writeConfirmedBrief(...)    ← NEW human-present writer (brief-writer.ts) the agent calls via
                                     `thebashway brief write --from <file>`; partial OR final.
```

The interview itself stays where it belongs — agent prose in `SKILL.md` — but now it has a real writer to call and a real status to resume from.

## 4. Detailed design

### 4.1 `gapsOf` — the shared readiness reader (pure, `src/engine/brief.ts`)

```ts
// src/engine/brief.ts (PURE — a reader, NOT a writer; sits beside renderBriefForPrompt/classifyDrift)
export interface BriefReadiness {
  gaps: string[];            // human-readable, plain-language, e.g. "what's out of scope", "success check"
  coreComplete: boolean;     // the Ring-1 core non-empty: purpose/whoServed/scope/limits (whyNow is OPTIONAL narrative, never gated)
  autonomousReady: boolean;  // a REQUIRED command criterion exists whose run is not the REPLACE-ME placeholder
  confirmed: boolean;        // mirrors brief.confirmed (convenience for callers)
}
export function gapsOf(brief: DesignBrief): BriefReadiness;
```

- Deterministic over field state — empty core fields become gaps; a success criterion still carrying the `echo REPLACE-ME && exit 1` placeholder makes `autonomousReady=false` and adds the "success check" gap.
- It is **the single source of truth** consumed by the status command, the gate, and the writer — so they can never disagree about "is this done?"
- `init.ts`'s existing `inferBriefDraft` gap logic is **aligned to** `gapsOf` (it already records the same `# GAP` sections; reconcile the wording so the seed gaps and `gapsOf` gaps match).
- Pure (no fs/spawn), so it is freely importable by `cli.ts` (gate + status) without touching INV-A.

### 4.2 The writer — `writeConfirmedBrief` + `thebashway brief write`

**`src/brief-writer.ts` (NEW — the human-present cold-start layer, NOT the engine):**

```ts
export function renderBriefModule(brief: DesignBrief): string;   // pure: a clean, commented, re-readable brief.ts text
export function writeConfirmedBrief(brief: DesignBrief, briefPath: string): void; // the IO write (writeFileSync)
```

- `writeConfirmedBrief` is **the second of the two sanctioned human-present writers** (the first is `init.ts`'s `seedBriefIfAbsent`). It performs the only non-init `writeFileSync(briefPath, …)` in the codebase. **INV-A holds**: the pure `src/engine/brief.ts` exports no writer; the engine stages (design/audit/drain/digest) import none; `renderBriefModule` is a pure string render (no IO), co-located with the writer in the human-present layer (not the engine) to keep the no-writer boundary visually obvious.
- It writes whatever `DesignBrief` it is given **verbatim** (the payload already carries `confirmed` and the field values) but **recomputes `gaps` via `gapsOf`** so the persisted gap list is always canonical, never trusted from the caller.
- The render produces the same human-readable, `export default { … }` shape `init` already emits (a person can still open and edit it).

**`src/cli.ts` — `cmdBriefWrite(cwd, args)` + dispatch (`thebashway brief write --from <file>`):**

1. `loadBinding` → resolve `briefPath`.
2. Read the JSON payload file; **zod `DesignBriefSchema.safeParse` at the boundary** (LLM-produced JSON may be malformed — a bad payload must NEVER corrupt `brief.ts`; reject loudly with the zod errors, non-zero exit, write nothing).
3. **Confirm guard:** if the payload sets `confirmed: true` but `gapsOf(brief).coreComplete === false`, refuse — print which of the Ring-1 core fields (purpose/whoServed/scope/limits) are still empty and exit non-zero (a premature confirm is a bug). The deferred success-command placeholder is the ONE allowed gap under `confirmed:true`, so it does not block; `whyNow` is optional and never blocks.
4. `writeConfirmedBrief(brief, briefPath)`.
5. Print the post-write status (via `gapsOf`): confirmed?, remaining gaps, autonomous-ready?

The payload is the **full current brief state**, so the one command serves both the **partial save** (`confirmed:false`, mid-interview) and the **final confirm** (`confirmed:true`, after read-back). No separate "draft" vs "confirm" verbs.

### 4.3 Resumability

- The interview **saves progress as it goes**: after each ring (or at any pause), Claude calls `brief write --from` with the fields gathered so far and `confirmed:false`. Progress is durable on disk immediately.
- On **resume**, Claude reads the existing brief + `gapsOf`, tells the owner "3 of 5 done," and asks **only the unanswered gaps**. The success-check gap is offered last and is skippable (deferred).
- The **final** call sets `confirmed:true` after the plain-English read-back and the owner's "yes."
- Because `gapsOf` is deterministic, resume state is computed from the file, not remembered in conversation — a brand-new Claude session resumes correctly from disk alone.

### 4.4 The brief-first gate

**Binding + config:**

| File | Change |
|---|---|
| `src/binding.ts` | Add `requireBrief?: boolean` to `RailsBinding` (co-located with `briefDriftSensitivity` — the other brief knob — and resolved in the same `defineThebashway` rails spread). Resolve `requireBrief: b.rails.requireBrief ?? true` AFTER `...b.rails`. Default **true** (north-star-first). Do NOT touch the `:140` throw guard. |
| `src/engine/config.ts` | Add `getRequireBrief(): boolean` accessor (set in `setBinding` with `?? true` coalescing, reset in `resetBinding`), mirroring `getBriefSensitivity`. |

**The gate decision (pure, testable):**

```ts
// a pure decision — cli.ts does the loadBrief IO + the printing
export function briefGateDecision(opts: {
  status: "ok" | "absent" | "unparseable";
  confirmed: boolean;
  readiness?: BriefReadiness;     // present when status==='ok'
  requireBrief: boolean;
  skipBrief: boolean;             // --skip-brief
}): { pass: boolean; message?: string };
```

- `pass=true` when `!requireBrief || skipBrief || (status==='ok' && confirmed)`.
- Otherwise `pass=false` with a **guided** message:
  - `absent` → "Your north star isn't set up yet — let's do that first: `thebashway brief`."
  - `confirmed:false` draft → "Your north star is in progress (N of M done). Finish it: `thebashway brief`." (uses `readiness.gaps`).
  - `unparseable` → the existing loud-signal wording ("brief exists but does not parse — fix it before continuing").

**CLI wiring — gate the WORK commands only:** `cmdFix`, `cmdBuild` (which serves both `build` and `design`), and `cmdRunToGoal` call `loadBrief(briefPath)` + `briefGateDecision(...)` at entry; on `pass=false` they print the message and return non-zero **without doing the work**. The bare-request default routes through `cmdBuild`/`cmdFix`, so it inherits the gate. `--skip-brief` is parsed per-run. The gate sits at the **CLI entry**, so internal drains spawned by `design`/`run-to-goal` are not double-gated. (There is no standalone `drain` CLI command — `drain` runs only internally — so nothing else needs gating.) **Never gated:** `init`, `brief`, `brief write`, `audit-plan`, `check-sync`, `update` (setup/inspection commands).

**Headless / back-compat:** headless and scheduled contexts set `requireBrief: false` (consistent with the existing scheduled-run guard pattern), since no human is present to interview. `run-to-goal` already refuses to *terminate* on an unconfirmed brief (`reason: 'brief-unconfirmed'`); the gate just turns that into an upfront guided stop instead of a wasted run.

### 4.5 The conversation (`SKILL.md`, tightened)

Update the existing north-star interview section to:
- Point the **confirmation step at `thebashway brief write --from <file>`** (drop the "hand-edit `brief.ts`" fallback now that the writer exists).
- Encode **save-as-you-go**: after each ring / at any pause, write a partial save (`confirmed:false`); resume reads `gapsOf` and asks only remaining gaps.
- Encode **translate-obvious-defer-rest** crisply for the success question: map obvious phrasings to a `command`/`verify` check and read it back; otherwise capture a plain human-judged `milestone` + leave the placeholder, telling the owner it's an optional "make-it-autonomous-ready" step, never a blocker.
- Require a **plain-English read-back** of the whole brief before the final `confirmed:true` write.
- Note the **gate**: build/fix won't run until the brief is confirmed; the agent's job after `init` is to funnel the owner straight into the interview.

### 4.6 Status — `thebashway brief` (enhance existing `cmdBrief`)

`cmdBrief` already (re)seeds + prints gaps. Enhance its output via `gapsOf` to show, in plain language: **confirmed or draft**, the **remaining gaps**, **autonomous-ready or not**, and the **single next step** ("run the interview" / "you're set" / "optionally fill the success check to enable hands-off runs"). No behavior change beyond richer status.

## 5. Wiring summary (files)

| File | Change |
|---|---|
| `src/engine/brief.ts` | + `gapsOf` + `BriefReadiness` (pure reader). |
| `src/brief-writer.ts` (NEW) | + `renderBriefModule` (pure) + `writeConfirmedBrief` (the IO writer). |
| `src/cli.ts` | + `cmdBriefWrite` (`brief write --from <file>`, zod-at-boundary, confirm guard) + dispatch; + `briefGateDecision` wiring on `build`/`fix`/`design`/`run-to-goal`/`drain` with `--skip-brief`; enhance `cmdBrief` status. |
| `src/binding.ts` | + `RailsBinding.requireBrief?` resolved-with-default `true` in the rails spread. |
| `src/engine/config.ts` | + `getRequireBrief()` accessor (set/reset). |
| `src/init.ts` | align `inferBriefDraft` gap wording to `gapsOf`; `initMessage` funnels into the interview. |
| `plugins/thebashway/skill/SKILL.md` | interview tightened: write-command, save-as-you-go, translate-obvious-defer-rest, read-back, gate funnel. |
| `thebashway.config.ts` (dogfood) + `examples/*.config.ts` | set `requireBrief: false` (or give the dogfood a confirmed brief) so self-builds + examples are not blocked the moment this ships. |

## 6. Test plan (`bun:test`)

- **`gapsOf`** (`brief.test.ts`): a fully-filled confirmed brief → `gaps:[]`, `coreComplete`, `autonomousReady`; an empty-core draft → core gaps + `coreComplete:false`; a confirmed brief whose only command is the `REPLACE-ME` placeholder → `autonomousReady:false` (the deferred case) yet still loads.
- **writer** (`brief-writer.test.ts` NEW): `writeConfirmedBrief` writes a file that **round-trips through `loadBrief` to `status:'ok'`**; the render is re-readable; `gaps` is recomputed via `gapsOf` (caller's stale gaps ignored). `renderBriefModule` is pure (same input → same output).
- **`cmdBriefWrite`**: a malformed JSON payload is **rejected at the boundary** (zod errors, non-zero, `brief.ts` untouched); a valid partial payload writes `confirmed:false`; `confirmed:true` with empty core fields is **refused** (confirm guard); `confirmed:true` with the deferred command placeholder is **allowed** and loads + is not trivially terminable.
- **gate** (`briefGateDecision`, pure, table-driven): pass when `!requireBrief` / `skipBrief` / confirmed; guided-stop messages for absent / draft (with the N-of-M gap count) / unparseable; a CLI test that a gated command (e.g. `build`) stops without doing work when unconfirmed and proceeds with `--skip-brief`.
- **back-compat**: `binding.test.ts` — `requireBrief` defaults to `true` without the `:140` guard throwing, the `minimal` fixture still resolves; `portability.test.ts` — `getRequireBrief()` set/reset; the example configs (with `requireBrief:false`) stay green.
- **INV-A**: a spy asserts the only `writeFileSync(briefPath)` paths are `seedBriefIfAbsent` and `writeConfirmedBrief`; the engine stages still import no writer.

## 7. Invariants preserved

- **INV-A** — the engine owns no brief writer. `writeConfirmedBrief` is the second *human-present* writer, in the cold-start/brief-command layer; `src/engine/brief.ts` stays a pure reader (`gapsOf` is a reader, not a writer); design/audit/drain/digest import no writer. The gate is a deterministic CLI read, not a write.
- **INV-B** — the brief stays a zod-validated TS module; the writer renders that exact shape; `loadBrief` (dynamic import + `safeParse`) is unchanged.
- **Back-compat** — `requireBrief` is optional-with-default and resolved in the spread; `--skip-brief` + `requireBrief:false` keep headless/automation/dogfood working; non-work commands are never gated.

## 8. Resolved decisions (confirmed with Bashir 2026-06-08) + risks

1. **Gate applies to existing repos too (RESOLVED: yes).** Default-true is the intended "north-star-first" stance and applies to already-using repos, not just new ones. The guided (non-crash) message that fires on a gate-stop **includes the opt-out** ("…or set `requireBrief:false` / pass `--skip-brief`"), so the message itself is the heads-up — no separate one-time notice needed. Override paths + the dogfood/example `requireBrief:false` keep automation working.
2. **`requireBrief` placement (RESOLVED: `RailsBinding`).** Kept on `RailsBinding` for spread-resolution consistency with `briefDriftSensitivity` — an internal organization choice, no user-facing effect.
3. **Confirm-guard line (RESOLVED: Ring-1 core).** Confirmation requires purpose/whoServed/scope/limits; `whyNow` and the deferred success-check are intentionally optional and never block.
4. **Partial saves at ring boundaries (RESOLVED).** The interview saves at ring boundaries / pauses — a few writes per interview, cheap and durable. Internal; no user-facing effect.

**Residual risk — rubber-stamp confirm.** A guided gate could nudge an owner to confirm a thin brief just to unblock work. *Mitigation:* the confirm guard requires the Ring-1 core (not just any non-empty draft), and `gapsOf` keeps remaining gaps visible in the status. Inherently a human-discipline limit, same as the parent epic's Risk 1.
