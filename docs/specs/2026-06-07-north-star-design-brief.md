---
created: 2026-06-07
status: BUILT 2026-06-08 (all 4 sub-features shipped on tbw/north-star; 408 tests pass, tsc clean)
scope: epic (4 sub-features, single epic, dependency-ordered a→b→d→c)
repo: ~/projects/thebashway
source: multi-agent design pass (4 approaches judged + 4 adversarial lenses) → converged with Bashir → second adversarial pass folded in
built: dogfood thebashway loop (per-phase building bashas + 3-lens cold review + fold). Commits — (a) 2c71e10, (b) a623837, (d) c880343, (c) 150541b.
---

# thebashway North Star — Per-Project Design Brief (v2)

**Status:** BUILT 2026-06-08 — all four sub-features shipped on `tbw/north-star` (a `2c71e10` → b `a623837` → d `c880343` → c `150541b`); 408 tests pass, tsc clean. · **Scope:** one epic, 4 sub-features built a→b→d→c · **Repo:** `~/projects/thebashway` · **Author:** lead architect synthesis (two adversarial review rounds folded in)

> **v2 note.** This document is the canonical replacement for the v1 spec. The v1 framing weighted *termination* as the headline purpose and then demoted it; a later design swing weighted *guidance* and demoted termination. **Both were wrong.** v2 settles the model: the brief is the living **project definition / guiding light**, and *guidance* and *autonomous termination* are **co-equal, both first-class** — two faces of one artifact. v2 also ships all four parts as **one epic in dependency order** (no MVP/defer split), adds the lean `conventions`/`glossary` schema fields, makes autonomous mode **part-or-all targetable**, and resolves a second round of adversarial findings (the v2 review-resolution subsection at the end). Every hard-won v1 detail — the two invariants, `CheckSpec`, `classifyDrift`, the parse-failure loud signal, the `confirmed:true` invariant, the exact hook points, the Review-resolution table — is **preserved**, not regenerated.

---

## 1. Purpose — the missing purpose layer

thebashway has two doors (Build, Fix) and both optimize for *correct*: the verify gate, the cold review, the adversarial finder, `classifyIrreversible` — every existing rail answers **"is this right?"**. Nothing answers **"is this what we should be building at all?"** This epic adds a per-project **design brief** (north star).

**The brief's primary purpose is to be the living PROJECT DEFINITION — the guiding light a human and the engine share.** It is the stable, top-level statement of what this project *is*, and it does four jobs **co-equally** (termination is **not** a bonus and **not** secondary):

1. **Guides every build/fix/audit decision.** Build, fix, audit, and decompose all read the brief as design context, so the work bends toward the project's actual purpose — in the project's own vocabulary (`glossary`) and habits (`conventions`) — rather than just toward "tests green."
2. **Minimizes drift from the CORE SCOPE specifically.** The brief's structured scope fields (`inScopeSurfaces` / `forbiddenSurfaces` / `forbiddenTerritory`) give the engine deterministic teeth to flag when a designed feature *contradicts the project's core scope*. The doc's #1 drift job reads as *"keep the project from wandering off what it is"* (§6).
3. **Feeds intake toward asymptotically-zero questions.** The brief is the stable top layer above the learned `decisions.md` layer; both feed `buildIntakePromptFromDisk`. A complete brief means feature intake **stops asking anything it could have derived from brief + decisions** — stated honestly as an **asymptote**, not a guarantee (§4bis).
4. **Provides the addressable goal-set autonomous mode drives toward.** The `successCriteria` are concrete, machine-checkable done-signals; autonomous mode (§5.4) can be aimed at any *slice* of that set or the *whole* set and runs until that target is met.

**The unified model (settles direction-vs-destination).** The north star is the **whole** — a guiding *direction* expressed as a *set of concrete goals / success-criteria* underneath it. Autonomous mode can be pointed at **any slice of that set (part) or the entire set (all)**, and it runs until *that target* is achieved. The star is the full goal-set; you aim the engine at whichever subset you want now.

Termination/autonomy and brief-as-guidance are **co-equal, both first-class** — neither is a "bonus." They are two faces of one artifact: the criteria that *guide* the build are the same criteria that *terminate* it. (The v1 framing weighted termination as primary then demoted it to a "bonus"; both were wrong.)

Because changing the goal function is pure judgment-zone, the brief is **read-by-the-engine, written-only-by-humans** (the two human-present entry points in §1.1) — never silently rewritten to make a misaligned ask fit.

**Scale = personal projects (scope boundary).** The brief and its interview are built for **one owner's personal projects**. The *process* is designed to generalize (a generic repo gets `.thebashway/brief.ts` and the same interview), but there is deliberately **no enterprise governance** — no multi-stakeholder sign-off, no approval chains, no role-based brief ownership, no org-policy layer. The single human-gate (the owner reacting to a draft, or approving a parked proposal) **is** the whole governance model. Keep it that lean; resist any refinement that adds organizational ceremony. This is a stated scope boundary, not an omission (§7, §8, §9).

### 1.1 Two architectural invariants that thread the whole spec (set by the review)

These are decided up front because every section depends on them:

- **INV-A — the engine owns no brief writer.** The brief read/parse module (`src/engine/brief.ts`) exports **no** write function. The *only* code that writes `brief.ts` lives in two named functions in the cold-start layer — `seedBriefIfAbsent()` (idempotent draft, in `init.ts`) and `writeConfirmedBrief()` (the human-present interview write, in the `brief` command path). Design/audit/drain/digest cannot `import` a brief writer because none is exported to them. This makes hold-firm #1 **structural**, not test-guarded (resolves R1-blocker-2, R1-major-milestone). **This invariant also binds the new lean schema fields (§3.2 `conventions`/`glossary`): they are "grown over time" only via the human-gated propose path (`emitPark`/`sinks`), exactly as `brief.ts` updates and `decisions.md` growth are — never an engine auto-write/auto-append to `brief.ts`.**
- **INV-B — the brief is structured data, not parsed prose.** The brief is stored as **`brief.ts` — a TypeScript module that `export default`s a zod-validated object**, loaded by dynamic `import()` exactly as `loadBinding()` loads `thebashway.config.ts` today (cli.ts). There is **no YAML and no hand-rolled markdown parser** (the repo has zod as its sole dependency and no YAML lib; the cited markdown precedents only *skip* `---` fences, they don't deserialize). A long human-readable `narrative` string field carries the prose; the structured fields (`successCriteria`, `milestones`, scope tags, `conventions`, `glossary`) are real typed data. (Resolves R1-major-yaml, R4-blocker-parse.)

The synthesis takes: **Termination-First's** discriminated-union `CheckSpec` (the cleanest encoding of checkable success); **Human-gate-first's** propose-not-write discipline and its `briefDriftSensitivity` knob; and **Thin Brief's** disciplined, **lean schema boundary** (kept lean *as an explicit design constraint* — the brief is pointers + recurring decisions, not a style-guide tome; "not overkill" is a requirement to honor, §3.2). It explicitly **drops** Thin Brief's "single chokepoint, zero per-callsite edits" framing (false — `buildIntakePromptFromDisk` is called inline at design-run.ts:406, design-run.ts:430, and audit-run.ts:372; brief injection is N edits, budgeted honestly — §6 Risk 6). Note (v2 correction): `runReview` (design-run.ts:437) builds its prompt **inline** and does **not** call `buildIntakePromptFromDisk`, so the true count of `buildIntakePromptFromDisk` callsites is **3** (design-run.ts:406, :430, audit-run.ts:372), not "3 + runReview."

## 2. The four hold-firm principles, and how the design honors each

**#1 — Living ≠ rewritten-on-demand.** A brief update changes the goal function → pure judgment-zone → AI-proposes-you-approve. *How:* INV-A (no engine writer). The milestone reflection emits a brief-update **proposal** routed to the **real, already-tested human-gate that exists in the engine** — `emitPark()` (park.ts → queue.md `@parked` + NOW.md `## Parked — needs your call`) plus the project-supplied `sinks.eventSink`/`notify` (binding.ts `SinkBinding`). There is **no** reliance on a lifeofbash-only `proposals/` directory (which does not exist in the portable engine). A human must act on the parked proposal before either human-present writer touches `brief.ts`. The *same* human-gated path is the only way the lean `conventions`/`glossary` fields grow over time (§3.2, §4.1 Ring 3) — and growth is **throttled** to the same milestone-marker + rate-limit the milestone proposal path uses (§5.5), so it cannot out-pace the rare-park guarantee in §6. (Resolves R1-blocker-1.)

**#2 — Calibrate the warning or it nags; and the brief is the stable layer that starves intake of questions.** Two things, one principle (don't ask what you already know, don't warn about what isn't a real contradiction):

- **Brief feeds intake.** The brief is the **stable top layer above the learned `decisions.md` layer** — both feed `buildIntakePromptFromDisk` (§4bis, §5.2). The aspiration: a complete brief means feature intake **asks nothing it could have derived from brief + decisions**. State this **honestly — it is an ASYMPTOTE, not a literal guarantee**: genuinely-novel decisions still surface and become new `decisions.md` entries or occasional human-gated brief updates. "Done perfectly ⇒ zero-input intake" is the *aspiration*; the *claim* is narrower and defensible — **intake stops asking anything derivable from brief + decisions.** (Over-claiming a literal zero is exactly what the v1 review punished; the honest framing is the one to ship.)
- **Material drift is a CORE-SCOPE contradiction.** The alignment check is **advisory only** — no code path aborts, parks-as-blocker, or forces `@needs-intake` on drift. "Material drift" means precisely **a core-scope contradiction**: the designed feature lands *outside* `inScopeSurfaces`, *inside* `forbiddenSurfaces`, or *inside* `forbiddenTerritory`. The deterministic pre-filter `classifyDrift` tests against those **structured** brief fields compared to the Design stage's **real, existing** output (`design.surface`) plus a **new** structured field the Design stage emits (`affectsTerritory`) — never fuzzy prose matching (resolves R2-blocker-input, R1-minor-freetext). The structured fields **are** the teeth; the framing is sharpened so the warning's #1 job reads as *"keep the project from wandering off its core scope."* Sensitivity is a binding knob `briefDriftSensitivity: 'off'|'low'|'medium'|'high'` with an `'off'` kill switch.

**#3 — Infer, don't interrogate.** *How:* Split cleanly along the interactive boundary the codebase enforces (every CLI command is `cmd(cwd, args): Promise<number>` — no stdin/readline). `runInit` (sync, no LLM) **always creates** `brief.ts` if absent, pre-filled from repo signals (including the inferred-first `conventions`/`glossary` — §3.2, §4.1). The **interview is conversational and lives in the interactive Claude Code agent** driven by `plugins/thebashway/skill/SKILL.md` prose — a **non-technical, progressive, infer-first interview** (§4.1 Stage 2): a small always-asked core (purpose / who is this for / core scope / what's explicitly out of scope / what would make you call it a success) plus conventions/glossary **inferred-and-confirmed**, *not* a CLI command pretending to prompt. The whole point: a non-technical owner can define the project's "schema" in plain language; Claude maps the answers to the structured fields behind the scenes. The CLI `brief` command does only non-interactive work: refresh/print the draft + gap list (resolves R2-blocker-cli).

**#4 — Success must be checkable enough to terminate.** *How:* `successCriteria` is a discriminated-union `CheckSpec` (`command` | `verify` | `file-exists`). A zod `.refine()` makes a brief with no **required, non-trivial, non-`verify`** machine-checkable criterion structurally unloadable — and the seeded `{kind:'verify'}` criterion **cannot alone satisfy terminability** (resolves R3-major-verify, R2-major-green). Human-judged `milestones` never feed the autonomous stop. The full criterion set is the addressable goal-set; autonomous mode can target a *slice* or *all* of it (§5.4). An unfilled `command` placeholder is an **expected, non-blocking cold-start state** for a non-technical owner (the brief still loads; only autonomous-to-goal stays disabled until a human/developer fills it — §4.1 Stage 2, §4.2).

## 3. The design brief: schema, format, location, naming

### 3.1 File format and location

- **Path:** declared in the binding (§5.1), default `<repoRoot>/.thebashway/brief.ts`. For lifeofbash the binding points it at **`tools/orchestrator/brief.ts`** — co-located with that repo's `lessons.md`/`decisions.md` (which live under `tools/orchestrator/`, *not* `.thebashway/`). The brief co-locates with whatever the binding declares for its learning stores; `.thebashway/brief.ts` is only the fresh-repo default (resolves R4-major-path).
- **Format:** a TS module `export default`ing a zod-validated `DesignBrief` object (INV-B). Human-editable; the `narrative` field holds the long prose. Loaded via dynamic `import()` (the `loadBinding` precedent), then `DesignBriefSchema.safeParse`.
- **Naming:** `brief.ts` (matches `config.ts`/the binding convention, and is directly importable).
- **Parse-failure contract (load-bearing):** a brief file that **exists but fails to parse** must **not** silently degrade to "no brief." It emits a **loud** signal — `emitPark("brief unparseable — north star not loaded", …)` + `notify` — so a botched human edit cannot silently disable the goal function. `loadBrief()` returns `{ brief: DesignBrief | null; status: 'ok'|'absent'|'unparseable'; errors: string[] }`; `absent` is the only state treated as benign "no brief." (Resolves R1-major-yaml failure-contract.)

### 3.2 Schema (new file `src/engine/brief.ts`, sibling to `design.ts`)

`brief.ts` is a **new pure file** — no fs, no spawn, **and no write export** (INV-A) — exporting the zod contract, the render helper, and the drift classifier. (The `loadBrief`/dynamic-import IO wrapper lives in `cli.ts`/a thin loader, not in `brief.ts`, to keep `brief.ts` pure and writer-free.)

```ts
// src/engine/brief.ts  (pure; exports NO writer)
import { z } from "zod";

export const CheckSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), run: z.string().min(1), expectExit: z.number().default(0),
             timeoutMs: z.number().int().positive().default(60_000) }),
  z.object({ kind: z.literal("verify") }),               // project's existing verify chain passes (surface chain)
  z.object({ kind: z.literal("file-exists"), path: z.string().min(1) }),
]);

export const SuccessCriterionSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  check: CheckSpecSchema,
  required: z.boolean().default(true),
});

// NEW: a domain term -> plain meaning. Keeps a NON-TECHNICAL reader oriented
// and makes Claude speak the project's own vocabulary in design/intake prompts.
export const GlossaryEntrySchema = z.object({
  term: z.string().min(1),
  means: z.string().min(1),
});

export const DesignBriefSchema = z.object({
  confirmed: z.boolean().default(false),     // INV: load-bearing — see §4.2
  narrative: z.string().default(""),         // the human-readable prose (purpose/why-now/etc. long form)
  purpose: z.string(),
  whyNow: z.string(),
  whoServed: z.string(),
  scope: z.string(),
  limits: z.string(),
  // structured drift signals — what classifyDrift tests against (no prose matching):
  inScopeSurfaces: z.array(z.string()).default([]),
  forbiddenSurfaces: z.array(z.string()).default([]),
  forbiddenTerritory: z.array(z.string()).default([]),  // globs the brief rules out
  timeHorizon: z.string().default(""),
  target: z.string().default(""),
  openExplorations: z.array(z.string()).default([]),
  // NEW (lean, inferred-first, grown-via-PROPOSAL — never engine-auto-written; INV-A):
  conventions: z.array(z.string()).default([]),         // how-we-do-things bullets: naming, testing norms,
                                                        // deploy/land norms, the handful of recurring calls
  glossary: z.array(GlossaryEntrySchema).default([]),   // domain term -> plain meaning (non-technical orientation)
  gaps: z.array(z.string()).default([]),     // un-inferred sections the interview must fill
  successCriteria: z.array(SuccessCriterionSchema).min(1),
  milestones: z.array(z.object({ statement: z.string().min(1), humanJudged: z.literal(true) })).default([]),
}).refine(
  // hold-firm #4 + R3/R2: at least one REQUIRED, machine-checkable, NON-verify, non-file-exists criterion.
  // The seeded {kind:'verify'} criterion cannot alone make a brief terminable.
  (b) => b.successCriteria.some(c => c.required && c.check.kind === "command"),
  { message: "brief must declare >=1 required 'command' success criterion (a purpose-bearing check; 'verify'/'file-exists' alone cannot terminate the loop — hold-firm #4)" }
);
export type DesignBrief = z.infer<typeof DesignBriefSchema>;
export type GlossaryEntry = z.infer<typeof GlossaryEntrySchema>;

// pure helpers (mirror surfaceRoles() in design.ts):
export function renderBriefForPrompt(brief: DesignBrief): string;   // compact + BOUNDED: purpose + scope/limits + top-N conventions + top-M glossary + success checklist; draft fields marked UNCONFIRMED
export function classifyDrift(
  design: { surface?: string; affectsTerritory?: string[]; summary?: string },
  brief: DesignBrief,
  sensitivity: "off" | "low" | "medium" | "high",
): { material: boolean; reason?: string };   // deterministic over STRUCTURED fields; 'off' & unconfirmed → {material:false}
```

**On `conventions` + `glossary` (LEAN by design constraint).** These two new arrays carry the project's *how-we-do-things* and *what-our-words-mean* — exactly the context that, fed through intake, lets a feature ask nothing it could have learned from the project's own habits and vocabulary. They are deliberately **pointers + recurring decisions, not a style-guide tome**: a handful of bullets (naming, testing norms, deploy/land norms, the recurring calls a build keeps making) and a short term→meaning list. "Not overkill" is an **explicit design constraint** here — if either array starts trending toward a wiki, that is drift from the schema's intent. Four hard rules govern them:

1. **Inferred-first from the repo.** The create-path seed (§4.1) pre-fills both from `package.json` scripts, the detected verify/deploy chain, and the README (see `inferBriefDraft`). They are *born populated where the repo betrays the answer*, listed in `gaps` where it does not.
2. **Confirmed in the interview.** A non-technical owner ratifies/edits them in plain language during the conversational interview (§4.1 Stage 2). `confirmed:true` remains load-bearing (§4.2): an unconfirmed draft's conventions/glossary inform prompts (marked UNCONFIRMED) but never harden into drift teeth.
3. **Grown over time ONLY via the human-gated propose path (INV-A — no exceptions), and THROTTLED.** When a milestone reflection notices a new recurring convention or domain term, it does **not** append to `brief.ts`. It emits a brief-update **proposal** through the same `emitPark()`/`sinks` human-gate that all brief updates use (§4.3) — identical in mechanism to how `decisions.md` grows. There is **no engine code path** that writes `conventions`/`glossary` (or any brief field) to disk; `brief.ts` exports no writer, so design/audit/drain/digest *cannot import one* (INV-A). Growth is additionally **throttled to the same milestone-marker + rate-limit the milestone proposal path uses** (§5.5): convention/glossary deltas fire **only** on an explicit milestone marker (not on every build / every noticed habit), are **batched into the single milestone-reflection `proposedUpdate`** (not separate park entries per term), and the existing "no new brief-update proposal while one is already parked" rate-limit covers them. This keeps growth from out-pacing the rare-park guarantee in §6 (resolves v2-major-grown-nag).
4. **Bounded at render time (structural floor, not just discipline).** `renderBriefForPrompt` **caps** how many convention bullets and glossary entries it renders into the prompt — top-N conventions (e.g. first 10) and top-M glossary entries (e.g. first 15), each with a `+K more` note when the stored arrays exceed the cap — so the prompt-injection cost stays **bounded regardless of how the stored arrays grow** over a project's life. The lean constraint is thus enforced at the one place it can bloat (the N design/audit prompt callsites), not left to human discipline alone. A test asserts a 100-entry array renders bounded (resolves v2-minor-render-cap, v2-minor-lean-floor). The prose `brief.ts` may hold more than the render cap (the file is for a human to read); the *prompt* never carries the whole array.

**On the `.refine()` requiring a `command` criterion (R3/R2 resolution).** The fresh-repo seed (§4.1) writes a brief that is born **NOT-yet-terminable**: `successCriteria` contains the seeded `{kind:'verify'}` entry marked `required:false` plus a single `command`-kind entry whose `run` is the placeholder `"echo REPLACE-ME && exit 1"` listed in `gaps`. This means the brief loads (the refine is satisfied by the presence of a required `command` slot) but cannot trip `goalMet` until a human edits the placeholder. "Born terminable" now means "has a real, not-yet-satisfied goal," never "trivially already done." For a non-technical owner, leaving that placeholder is an **expected cold-start state** — the brief is fully usable as guidance; only autonomous-to-goal stays disabled until a developer fills it (§4.1 Stage 2, §4.2).

**Why the discriminated union:** "a criterion that cannot be expressed as a runnable command/verify/file-exists cannot enter `successCriteria`" is a *schema invariant*, not a prompt instruction. Genuinely-fuzzy goals ("UX feels fast") are first-class but live in `milestones` (human-judged), routed to reflection-as-questions and to the **stop-and-ask** terminal state (§5.4), never to a silent autonomous "done."

## 4. Lifecycle

### 4.1 (i) Init: infer-and-confirm (draft-to-react-to)

**Stage 1 — non-interactive seed (`seedBriefIfAbsent()`, called from `runInit`, `src/init.ts`).** Right after the lessons/decisions seed block (init.ts:172–174), the single named writer:

```ts
const briefPath = join(dir, ".thebashway", "brief.ts");
if (!existsSync(briefPath)) {           // R2-minor: heavy inference gathered ONLY on the create path
  const inputs = await gatherBriefInputs(dir);   // README 1st para + pkg name/desc/SCRIPTS + `git log --oneline -20` (spawnSync)
  writeFileSync(briefPath, inferBriefDraft(inputs).module, "utf8");
}
// idempotent re-run: existing brief untouched, NO inference I/O performed
```

- `gatherBriefInputs(dir)` is a **new** sync helper (the inputs are *not* in `detectProject` today, and the existing git shelling lives in `runInit`, not `detectProject` — correcting the hook-map). It reads `package.json` name+description **+ `scripts`** (the scripts feed the inferred `conventions`), the README first paragraph (`readFileSync`), and `git log --oneline -20` (`spawnSync`, mirroring runInit's existing git calls). Synchronous, so `runInit` stays sync. Guarded behind the `!existsSync` create check so idempotent re-runs do zero extra I/O (resolves R2-minor-latency, R4-minor-detect).
- `inferBriefDraft(inputs): { module: string; gaps: string[] }` is **pure**: fills `purpose`/`whyNow`/`whoServed`/`narrative` it can guess, seeds `successCriteria` with the `{kind:'verify', required:false}` entry **and** the `command` placeholder, records every un-inferred section in `gaps`, **and seeds `conventions`/`glossary` from repo signals (create-path only):**
  - **`conventions` seed** — derive lean bullets from the detected build chain and `package.json` scripts: e.g. a `test` script → `"Tests run via \`<runner> run test\`; rely on the green gate, don't build a new harness for a small fix."`; a `build`/`deploy` script or a Next surface → a deploy/land norm bullet; the detected runner → `"Package manager: <runner>."`. These mirror facts the engine already extracts in `detectProject`, surfaced as prose conventions. Anything not inferable is left empty and listed in `gaps` (e.g. `# GAP: naming conventions`, `# GAP: deploy/land norm`).
  - **`glossary` seed** — extract candidate domain terms from the README first paragraph + `package.json` name/description (proper-noun-ish tokens, the product name), each with a *placeholder* `means` the interview confirms; if nothing confident is found, `glossary` stays `[]` and a `# GAP: glossary (domain terms)` is recorded. The seed never invents meanings it can't ground — an unconfident term is a gap, not a guess.
  - `confirmed:false` **always**. The seeded conventions/glossary are a draft to react to, never ratified by inference.
- **New/empty repo:** `BRIEF_SEED` constant (sibling to `LESSONS_SEED`/`DECISIONS_SEED` at init.ts:101–102) — the skeleton module with all narrative fields empty, `conventions:[]`, `glossary:[]`, `gaps` listing every section (including `conventions`/`glossary`), `confirmed:false`, the `verify` placeholder. The interview carries the weight here.
- `interface InitResult` gains `briefCreated: boolean` and `briefGaps: string[]`. `initMessage(r)` prints: `Drafted .thebashway/brief.ts from the repo (N sections to confirm). Run \`thebashway brief\`, then have the agent walk you through it.`
- `configTemplate()` emits the brief path in the generated `learning:` block (§5.1).

**Stage 2 — conversational, NON-TECHNICAL progressive interview (agent-driven, via SKILL.md; CLI `brief` command does the non-interactive parts only).** Because no CLI command can hold a conversation (every CLI command is `cmd(cwd, args): Promise<number>` — no stdin/readline), the react-to-draft interview is **agent behavior** documented in `plugins/thebashway/skill/SKILL.md`. Its design goal: **a non-technical owner can define the project's "schema."** The agent asks plain-language, guided questions a non-technical person can answer, and **maps the answers to the structured schema behind the scenes** — the owner never sees `inScopeSurfaces` or `CheckSpec`; they answer "what's this for?" and "what would make you say it worked?".

The interview is **progressive + infer-first**, in three concentric rings (cold start stays LIGHT):

- **Ring 1 — the small always-asked CORE (every repo, always asked).** Five plain questions, each mapping to schema fields:

  | Plain-language question | Maps to schema field(s) |
  |---|---|
  | "In a sentence — what is this for?" | `purpose` (+ `narrative`) |
  | "Who is this for?" | `whoServed` |
  | "What's the core of it — the part that, if it broke, the whole thing is pointless?" | `scope`, `inScopeSurfaces` |
  | "What is explicitly NOT this project — what should it never turn into?" | `limits`, `forbiddenSurfaces`, `forbiddenTerritory` |
  | "How would YOU check it's working — what would you look at, click, or see?" | `successCriteria` (the agent's job is to **translate** the plain answer into a candidate `command` CheckSpec and read it back to confirm — see below) |

  **The success question stays plain-language; the agent does the schema-mapping (resolves v2-major-jargon-leak).** The single most consequential interview question is the one whose answer the schema hard-requires (the `.refine()` demands a required `command`; the seed ships `echo REPLACE-ME && exit 1` in `gaps`). A non-technical owner **cannot** be asked for a shell command. So Ring 1 asks only *"How would YOU check it's working — what would you look at, click, or see?"* and the agent's **documented duty (SKILL.md)** is to:
  1. **Translate** the plain answer into a candidate `command` CheckSpec and read it back for confirmation — *"so I'll check that by running `<cmd>` — does that capture it?"*;
  2. when **no command is derivable** from the plain answer, route the goal to `milestones` (human-judged) and leave the `command` placeholder as an explicit `# GAP` the owner is told **a developer must fill later**;
  3. state plainly that an unfilled `command` placeholder is an **EXPECTED, non-blocking cold-start state** — the brief still loads and guides; only autonomous-to-goal stays disabled until the placeholder is filled. The interview never dead-ends on this question.
  The words "command" and "tests-green" are **dropped from what the owner sees**; the agent presses only on *meaning* ("what would convince you it works?"), never on shell syntax.

- **Ring 2 — INFERRED-AND-CONFIRMED conventions & glossary.** The agent does **not** ask these cold. It **presents the inferred draft** from Stage 1 — *"I see you use `<runner>`, tests run with `<test cmd>`, and you deploy with `<deploy cmd>`; I've written that down as how-we-work — anything to add or correct?"* and *"Here are the terms I picked up: `<term>` — what does that mean to you?"* The owner confirms, edits, or fills the `# GAP`s in plain language. This is the ring that makes intake's stable layer real without interrogating: most of it is *confirm-the-guess*, not *answer-from-scratch*.

- **Ring 3 — GROWN over the project's life (THROTTLED).** Conventions and glossary are *not* finished at init. As the project runs, milestone reflection (§5.5) **proposes** additions — routed through the human-gated `emitPark`/`sinks` path (§4.3, INV-A), never auto-written, and **throttled exactly like the milestone `proposedUpdate`**: fired **only** on an explicit milestone marker (not on every build / every noticed habit), **batched into the single milestone-reflection proposal** (not one park entry per term), and suppressed by the existing rate-limit while a proposal is already parked (§5.5). The interview at init is the cold start; the brief keeps maturing by proposal thereafter. This is what "grown over time" means concretely, and it honors INV-A absolutely while keeping `## Parked` rare (resolves v2-major-grown-nag).

On confirmation the agent calls the single writer `writeConfirmedBrief()`, which writes the agreed brief (core + conventions/glossary the owner ratified) and flips `confirmed:true`. The CLI `thebashway brief` (`cmdBrief`) is the non-interactive companion: `(re)seed the draft if missing` + `print the draft path and the gap list` + (optionally) run one Opus pass to *suggest* gap fills as text for the human to react to — it never silently auto-authors a confirmed brief. (Resolves R2-blocker-cli.)

**Cold start stays LIGHT.** Ring 1 is five plain questions; Rings 2–3 are confirm-and-grow, not interrogate. A non-technical owner can complete the cold start in a short back-and-forth; nothing forces them to pre-write a style guide, enumerate globs, or type a shell command. The agent does the schema-mapping; the owner stays in plain language throughout.

### 4.2 (ii) Load / inject + the `confirmed` invariant

The brief **content is loaded fresh each run** via `loadBrief(briefPath)` (dynamic `import()` + `safeParse`, per INV-B), returning `{brief, status, errors}` (§3.1 failure contract). Every downstream consumer treats `status:'absent'` as "no brief" (back-compat — a bare/pre-brief repo behaves exactly as today) and `status:'unparseable'` as the loud-signal path.

**`confirmed:true` is load-bearing (resolves R1-major-confirmed):** while `confirmed === false` —
- (a) the brief **still injects as design context** (advisory — fine), **but** `renderBriefForPrompt` **marks every gap/unconfirmed field as DRAFT/UNCONFIRMED** so the prompt does not present a guessed scope as settled fact (resolves v2-minor-thin-intake-degrade — see §4bis); 
- (b) `classifyDrift` treats an unconfirmed brief as `sensitivity:'off'` (never warn against a vision no human ratified), and
- (c) success-termination **refuses to terminate** on an unconfirmed brief — `runToGoal` (§5.4) falls back to count-bounded behavior, returns `reason:'brief-unconfirmed'`, and notifies "brief unconfirmed; autonomous-to-goal disabled until confirmed."

This keeps init's "always create" (hold-firm #3) while guaranteeing an un-ratified, machine-inferred draft can never act as the goal function (hold-firm #1). The intake-feed degrades gracefully: a thin/unconfirmed brief **may** still inject (it is advisory context, parallel to (a)), but because its draft fields are marked UNCONFIRMED, it does **not** over-suppress intake questions by presenting a guessed scope as authoritative — a thin brief degrades toward "intake still asks," not "intake wrongly stops asking." Tested in `brief.test.ts` + `drain.test.ts` + `intake-prompt.test.ts`.

The brief reaches LLM stages via `renderBriefForPrompt(brief)` threaded through `buildIntakePromptFromDisk` — 3 callsite edits (§4bis, §5.2), budgeted honestly.

### 4.3 (iii) Propose-update flow (human-gated, routed to a REAL mechanism)

The brief is updated only via: (1) the human re-running the agent interview or hand-editing `brief.ts`, or (2) approving a milestone-reflection **proposal**. The reflection (§5.5) **never writes `brief.ts`** (INV-A). It stages the proposed delta through the engine's existing human-gate: `emitPark({ item: "brief-update proposed", reason: <delta summary> }, …)` (queue.md `@parked` + NOW.md `## Parked — needs your call`) plus `sinks.eventSink`/`notify` for projects that wire an external feed. This mirrors how `audit-run.ts:132` forces design findings to `needs-intake` deterministically — the loop never trusts an LLM to change its own goal function. **The same path carries `conventions`/`glossary` growth** (§3.2 rule 3, §4.1 Ring 3): a proposed new convention or term is **batched into the single milestone `proposedUpdate`** and **rate-limited** (no new proposal while one is parked), so growth cannot become a nag. `decisions.md` gains two `[decision]` doctrine entries and `lessons.md` one `[rail]` entry (§5.6) backing the propose-not-rewrite and material-drift-only rules. (Resolves R1-blocker-1; the false "existing proposals/ mechanism" claim is dropped.)

## 4bis. Brief feeds intake — the stable layer above learned `decisions.md`

The intake prompt is assembled by `buildIntakePromptFromDisk` (`src/engine/intake-prompt.ts:30`). Today it has **one** context layer: the **LEARNED** layer — `decisions.md` Active rules, read via `readLessons(decisionsPath)` and rendered as the "Decision defaults — apply before asking Bashir:" block (intake-prompt.ts:24). This layer *accretes* — every answered question becomes a new `[decision]`/`[area]` rule, so it grows organically but never describes the project as a whole.

The brief adds a **STABLE top layer** above it:

```
buildIntakePromptFromDisk(opts)
  ├─ STABLE layer  : renderBriefForPrompt(brief)   ← NEW. purpose + scope/limits + (bounded) conventions + glossary + success checklist.
  │                                                   The project's identity; changes only via human-gated propose (INV-A).
  └─ LEARNED layer : decisions.md Active rules      ← EXISTING. accreted one answered-question at a time (Loop A).
```

Both feed the *same* prompt. Concretely, `buildIntakePromptFromDisk` gains optional `brief?: DesignBrief | null` / `briefPath?: string`; when a brief is present it is rendered **above** the decision-defaults block as **"North star — build toward this:"** (the label is **purely directional**; the deterministic drift flag is the separate `classifyDrift` step in `runFeatureDesign` at design-run.ts:129 — the intake/decompose prompt does **not** instruct the LLM to perform the drift check in-prompt; resolves v2-minor-label-double-count). Omitting the brief leaves existing callers/tests byte-identical (the option is additive).

**Why two layers, honestly.** The stable layer answers *"what is this project, what does it call things, how does it do things, what is in/out of scope"* once. The learned layer answers *"what did a human decide the last time this exact ambiguity came up."* Together they shrink the question surface from two directions: the brief removes whole classes of questions up front (a new feature inherits the project's conventions/glossary/scope without asking), and `decisions.md` removes the residual case-by-case ones as they get answered.

**The asymptote claim — stated HONESTLY (this is what the v1 review punished).** A **complete** brief means feature intake **stops asking anything derivable from brief + decisions**. That is the aspiration and the design target — "done perfectly ⇒ zero-input intake." It is an **asymptote, not a literal guarantee**:

- Genuinely-novel decisions — ones neither the brief's stable identity nor any prior `decisions.md` rule covers — **still surface**. That is correct, not a failure: a genuinely new judgment call *should* reach the human.
- Each such surfaced decision becomes either a **new `decisions.md` entry** (the common case — the learned layer grows, via the existing Loop A path) or, when it changes the project's identity/scope/conventions/glossary, an **occasional human-gated brief update** (the rare case — via the §4.3 propose path, INV-A).
- So intake questions trend toward zero *over the life of the project*, never hit a hard zero. **Do not over-claim it.** The honest framing the doc commits to: **"intake stops asking anything derivable from brief + decisions"** — not "intake asks nothing, ever."

This is the same maturation curve the per-item question rate already tracks (the graduation gate in the autonomous-build-loop spec); the brief just gives that curve a faster-decaying stable component on top of the learned one.

**Graceful degradation of a thin/early brief (intake-feed path; resolves v2-minor-thin-intake-degrade).** The drift path forces unconfirmed→`'off'` (§4.2b) and the termination path refuses on unconfirmed (§5.4); the **intake-feed** path degrades differently — it **may inject** an unconfirmed/thin brief as advisory context (parallel to §4.2a), **but** `renderBriefForPrompt` clearly marks gap/unconfirmed fields as `DRAFT/UNCONFIRMED`, so Claude does not treat a guessed-but-unratified scope line as authoritative and wrongly *stop asking* a question it should ask. A thin brief therefore degrades toward over-asking (safe — "intake still asks"), never toward over-suppressing.

**Honest wiring accounting (resolves v2-minor-auto-intake-coverage).** The brief feeds the **three** `buildIntakePromptFromDisk` design/audit callsites (design-run.ts:406, :430, audit-run.ts:372). `buildIntakePrompt`'s other caller — `auto-intake.ts:77` `listIntakeCandidates`, the `@needs-intake` promotion path — is **intentionally NOT brief-fed in this epic**: the design door is where drift and project-identity context matter, and scoping the stable layer to the design/audit shaper paths keeps the change surface honest. A reader should **not** assume universal intake coverage. (If desired later, add the optional `brief?` to `BuildIntakePromptOptions` — not just the `FromDisk` wrapper — so `auto-intake` can pass it; this is a named, deferred extension, not part of this epic.)

**Owner-name parameterization (resolves v2-minor-owner-leak).** The existing LEARNED-layer header renders as "Decision defaults — apply before asking Bashir:" (intake-prompt.ts:24) — owner-specific. For the generalization claim in §1/§7 to hold, the integrator should parameterize (or genericize to "…before asking the owner:") the owner name when the brief-feed lands. Low effort, additive to the already-budgeted intake-prompt edit; flagged so a Bashir-named prompt is not shipped into a generic-repo feature.

## 5. Wiring per loop stage (exact files/functions)

### 5.1 Cold-start / binding / config / CLI

| File | Function / line | Change |
|---|---|---|
| `src/binding.ts` | `interface LearningBinding` (:88) | Add `brief?: string` (path, default `.thebashway/brief.ts`). |
| `src/binding.ts` | `defineThebashway()` (:126), the return spread (:143–149) | Resolve **both** new defaults in the single resolution site (resolves R4-major-split-resolution): add to the returned object `learning: { ...b.learning, brief: b.learning.brief ?? ".thebashway/brief.ts" }` **and** `rails: { ...b.rails, briefDriftSensitivity: b.rails.briefDriftSensitivity ?? "medium" }`. **Do NOT** extend the throw guard at :140 (it throws only on missing `learning.local`/`learning.decisions`; adding `brief` there breaks the `minimal` fixture and every existing config). Optional-with-default preserves back-compat. |
| `src/binding.ts` | `interface RailsBinding` (:81) | Add `briefDriftSensitivity?: 'off'|'low'|'medium'|'high'`. Placed on `RailsBinding` because it is resolved in the same spread as the rails territory/keywords and read by the same `setBinding` rails path — lowest-friction (Q6 resolved: keep on `RailsBinding`). |
| `src/engine/config.ts` | accessor quartet (`_DEFAULTS` :237, accessors :252–260, `setBinding` :263, `resetBinding` :274) | Add `let _briefPath` + `export function getBriefPath(): string`, and `let _briefSensitivity` + `getBriefSensitivity()`. Set both in `setBinding` from `b.learning.brief` / `b.rails.briefDriftSensitivity`, **belt-and-suspenders coalescing** (`?? '.thebashway/brief.ts'`, `?? 'medium'`) so a raw binding injected directly in a test still behaves. **Reset both in `resetBinding`** or tests cross-contaminate. Follow `getRepoRoot`/`getDefaultSurface` exactly. |
| `src/cli.ts` | `derivePaths()` / `DerivedPaths` | Add `briefPath` resolved from `binding.learning.brief`. |
| `src/cli.ts` | `cmdBuild`, `cmdFix` | Thread `briefPath` into `runFeatureDesign` opts + `defaultDesignDeps`, and into the audit deps. |
| `src/cli.ts` | new `cmdBrief` + dispatch | Non-interactive: (re)seed if missing, print draft path + gap list, optional Opus *suggestion* pass (§4.1 Stage 2). The reflection `proposedUpdate` routes via `emitPark`/sinks — **never** an auto `git push origin main` (memory `main-branch-classifier-gate`). |
| `src/cli.ts` | new `cmdRunToGoal` (or `cmdBuild --to-goal`) + dispatch | Autonomous entry point (§5.4): resolves `briefPath`, accepts optional `--target <id,…>` (the part-or-all slice), calls `runToGoal`. |
| `examples/lifeofbash.config.ts` | `learning:` block (:112–116) | Add `brief: 'tools/orchestrator/brief.ts'` (mirrors its absolute lessons/decisions location — resolves R4-major-path). |
| `examples/nextjs-minimal.config.ts` | `learning:` block (:30) | Add `brief: '.thebashway/brief.ts'` (matches what `init` scaffolds; exercises the field on a never-seen binding in the portability test). |
| `src/router.ts` | **NON-HOOK** | Document that alignment does **not** live here. Router stays a thin 2-way correct/safe classifier with the `'fix'` safe-default. No third Mode, no routing-time model call. |

### 5.2 Design / build gate (the prompt injection + the alignment input)

| File | Function / line | Change |
|---|---|---|
| `src/engine/design.ts` | `FeatureDesignSchema` (:21–32) | **Add one structured field** `affectsTerritory: z.array(z.string()).default([])` (the glob list the design will touch), emitted by the Design stage. This gives `classifyDrift` a **real structured signal** to test against `brief.forbiddenTerritory`/`inScopeSurfaces` — instead of fuzzy-matching free-text `summary` (resolves R2-blocker-input, R1-minor-freetext). `design.surface` already exists and is tested against `forbiddenSurfaces`. |
| `src/engine/intake-prompt.ts` | `BuildIntakePromptOptions` (:9), `buildIntakePrompt` (:18), `buildIntakePromptFromDisk` (:30) | Add optional `brief?: DesignBrief \| null` and `briefPath?: string`. When present, push `renderBriefForPrompt(brief)` into `parts[]` as **"North star — build toward this:"** (directional label only) before the decision-defaults block. Genericize/parameterize the "before asking Bashir" owner name in the same edit (§4bis). Optional → existing callers/tests byte-identical. |
| `src/engine/design-run.ts` | `defaultDesignDeps` `runDesign` (:406), `runDecompose` (:430) | Pass `briefPath` into **both** `buildIntakePromptFromDisk` calls. The Design stage prompt instructs emitting `affectsTerritory`. (Note: `runReview` at :437 builds its prompt inline and is **not** a `buildIntakePromptFromDisk` callsite — so this is 2 design-side edits + 1 audit-side, **3 total**, not "+ runReview".) |
| `src/engine/design-run.ts` | `runFeatureDesign` after `let design = await deps.runDesign(...)` (:129) | Insert the **deterministic alignment step**: `const drift = classifyDrift({surface: design.surface, affectsTerritory: design.affectsTerritory, summary: design.summary}, brief, getBriefSensitivity())`. If `drift.material`, optionally fire LLM Tier 2 (`runAlignmentCheck?` dep), record into `DesignReport.alignment?: { material; reason?; offer? }`, append to `summary` + emit via `deps.notify`/`emitPark` **only when a human call is genuinely needed**. **NEVER** sets `report.aborted`, **NEVER** forces `@needs-intake`. Design proceeds (default = build-anyway). |
| `src/engine/design-run.ts` | `DesignOptions` (:54), `DesignReport` (:72) | `DesignOptions` gains `briefPath?`; `DesignReport` gains optional `alignment`. |

`design-bar.ts` is a **model, not an edit**. Injected-block ordering: operating rules → build lessons → **brief / north star** → taskBody → DESIGN_BAR (purpose before the task; quality gate last).

### 5.3 Audit / fix prioritization (the IN-door) — scoped to honesty

The review correctly found that `kind === 'design'` is **already** force-parked at audit-run.ts:132 and there is **no `maintenance` kind** today, so a naive "deprioritize non-bug findings" gate has **no inputs** and would be inert (R2-major-audit-noop, R4-blocker-no-carrier). Resolution: **the audit side ships the honest, low-risk version (option a) in this epic; the deterministic gate (option b) is named as dependent on a schema change and rides with the (d) wave if wanted.**

| File | Function / line | Change |
|---|---|---|
| `src/engine/audit-run.ts` | `defaultAuditDeps.runShape` `buildIntakePromptFromDisk` (:372) | Pass `briefPath` so the shaper **justifies findings against the north star** in prose and may itself choose `status:'needs-intake'` + `openQuestion`. This is the **only** in-epic audit change. |
| `src/engine/audit-run.ts` | shape loop, after the design-kind rail (:132) | **No new deterministic gate.** Design findings are already parked; correctness findings are off-limits (correctness is not subject to vision). State plainly that the audit-side brief effect is **prompt context only** — and that it must **never increase the `needs-intake` count** for design-kind findings (they were already there). A test asserts the count is unchanged. |
| `src/engine/audit.ts` | `FindingSchema.kind` (:54) — **optional, rides with (d)** | If a real deprioritization gate is wanted: widen `kind` to add `'maintenance'`, make the finder emit it, add advisory `briefAdvances: z.boolean().optional()` the shaper sets, then gate `kind !== 'correctness' && briefAdvances === false → needs-intake`. **Named dependency, not "optional."** `'correctness'` stays the only unconditional class; `effectiveQueueStatus` stays the lone status authority. |

### 5.4 Drain / autonomous termination (scope d) — **first-class, IN this epic, part-or-all targeting**

> **Status change from v1.** v1 marked (d) "deferred" and framed termination as a "bonus" after the alignment gate. That framing is wrong on both counts: termination/autonomy is **co-equal and first-class** with the brief-as-guiding-light (§1), and (d) ships **in this epic** in dependency order a → b → **d** → c (§7). The mechanism, caps, and rails below are unchanged from v1's hard-won design; what changes is (1) (d) is built, not deferred, and (2) `runToGoal` gains **part-or-all targeting** so the engine can be aimed at any *slice* of the goal-set, not only the whole set.

**The unified model this implements.** The north star is the **whole** — the guiding direction expressed as the brief's `successCriteria` set. Autonomous mode can be aimed at **any slice** of that set (part) or the **entire** set (all), and runs until *that target* is achieved. The star is the full goal-set; `targetCriteria` points the engine at whichever subset.

The v1 review found (correctly) that the headline "run until the goal is met" had **no hook**: a single `drain` is hard-bounded by `n` and `if (!item) break` (drain.ts:212, drain.ts:218), so the in-loop break can only stop *sooner*, never run *until done*; the "re-invoking driver" was a phantom (R3-blocker-no-hook, R3-blocker-no-work-bridge, R2-major-rununtil). Resolution unchanged: **(d) ships a first-class, named, cost-capped driver, and is honest about what it does** — now with part-or-all targeting layered on top.

| File | Function / line | Change |
|---|---|---|
| `src/engine/brief.ts` (or a sibling `brief-eval.ts`) | new | `export async function evaluateCheckSpec(spec, run: Runner): Promise<{pass: boolean}>` — a **testable** per-kind evaluator behind the injected `Runner` seam (the same seam `runChain` uses). `command` → `run(cmd, {cwd: repoRoot})` with the **per-CheckSpec `timeoutMs`** (default 60s; **a timeout counts as FAIL, never pass**); `verify` → run the surface's full chain via `runChain(binding.surfaces[s].chain, surface, run)` (the real signature — `runChain(surface.chain, surface, bunRun)` at verify/index.ts:65); `file-exists` → `existsSync`. Only the real-process wiring stays un-unit-tested; the decision logic is unit-tested with a fake Runner (resolves R3-major-oracle). Note: `bunRun` (verify/run.ts) has no timeout today — add an optional timeout to the Runner contract and enforce it in `evaluateCheckSpec` (kill on timeout). |
| `src/engine/breaker.ts` | new export beside `shouldTrip` (:11) / `overBudget` (:18) | **`goalMet` reduces over the TARGET set, not the whole set.** Signature is unchanged in shape — it already takes the target id-set as its second argument, so **part-or-all targeting is expressed by what the caller passes**, NOT a new parameter (the reducer stays a pure, target-agnostic primitive — `runToGoal` is the only thing that decides the target). The **empty-set ⇒ `false`** guard is **load-bearing and unchanged**: vacuous-truth is the wrong default for a termination gate — "nothing checked / target is empty" must never mean "done" (resolves R3-minor-empty / Q4). Returns true iff `targetSet` is non-empty AND every id in `targetSet` is present-and-passing. Table-driven tests incl. the empty-set case and a strict-subset target. |
| `src/engine/autonomous.ts` (**NEW FILE**) | `runToGoal(opts, deps): Promise<RunToGoalResult>` | The **named** re-invoking driver the feature's headline needs (resolves R3-blocker-no-hook), now **part-or-all aware**. See the signature, the targeting/validation contract, and the honest terminal-state set below. Loop: **resolve+validate the target set first**, then **evaluate `briefSatisfied(target)` at loop TOP** (resolves R3-minor-entry: if the *target* is already met → return `reason:'already-satisfied', built:0`); else run one `drain` → re-evaluate the target → repeat. |
| `src/engine/autonomous.ts` | runaway guards | **REQUIRED, unchanged from v1** (resolves R3-major-no-cap, memory `bashir-cost-sensitive`): `maxIterations` (default **5**), `maxWallClockMs`, and a cumulative cost ceiling via `overBudget` (breaker.ts:18). Plus a **no-progress detector distinct from the failure breaker**: if an iteration completes green but the set of *passing target criteria* is unchanged from the prior iteration, increment a stall counter and stop after **K=2** stalls (catches "green builds that never move the needle" — which `shouldTrip` misses because it only counts failures). **Note: the no-progress detector reduces over the TARGET passing-set**, not the whole `successCriteria` passing-set — aiming at a slice must not stall just because *other* (untargeted) criteria didn't move. Hitting any cap → `reason:'cap-hit'` + human notify. |
| `src/engine/drain.ts` | `DrainDeps` (:58) | Add optional seam `briefSatisfied?(brief: DesignBrief, target?: Set<string>): Promise<boolean>` (default undefined = today's behavior → all 40+ drain fakes pass). The **optional `target` argument** is how `runToGoal` tells the in-drain early-stop which slice it is driving toward; omitted ⇒ the real impl uses *all required* ids (back-compat). Real impl in `defaultDrainDeps` reduces `evaluateCheckSpec` results with `goalMet(checked, target ?? allRequiredIds)`. Never run in unit tests; the *reducer and evaluator* are tested separately. |
| `src/engine/drain.ts` | `DrainOptions` (:94), `DrainReport` (:119) | `DrainOptions` gains `stopWhenBriefMet?: boolean` (the in-drain early-stop short-circuits a single drain *early*, it does **not** loop; the looping is `runToGoal`'s job — resolves R2-major-naming) **and** `targetCriteria?: string[]` (passed through to `briefSatisfied`'s `target`, so a single drain invoked directly can early-stop against a slice). `DrainReport` gains `goalMet?: boolean`. |
| `src/engine/drain.ts` | after a successful integrate, next to the breaker check (:293) | `if (opts.stopWhenBriefMet && await deps.briefSatisfied?.(brief, opts.targetCriteria && new Set(opts.targetCriteria))) { report.goalMet = true; break; }`. **Gates NEW CLAIMS ONLY** — never bypasses `shouldTrip` (breaker, :293), `unsafeIntegrationBranch` (:144), feature-atomic landing, or the default-on land. `goalMet` lands what's green via the unchanged `landFn`. **Opt-in.** The feature-isolated design-door drain (`claimTitles`/`allowTitles` set, :168) **ignores** `stopWhenBriefMet` — it is feature-atomic and must not self-terminate on a global goal. |
| `src/engine/drain.ts` | `runBasha` taskBody (~drain.ts:404, the build block) | Optionally append a **one-line** `Building toward: <north-star one-liner>` (compact, not the full doc). Lower priority; the item already encodes territory + done-when. Unchanged from v1. |
| `src/engine/headless.ts` | **NO CHANGE** | Reused as-is: infer/reflect/align call `runClaude({ model:'opus' })` exactly as design-run/audit-run do; parse with the shared `extractJsonBlock` + zod `safeParse`. The unmetered-subscription invariant (`headlessEnv` deletes `ANTHROPIC_API_KEY`, headless.ts:66) is load-bearing and untouched. |

#### `runToGoal` — exact signature & the part-or-all targeting contract

```ts
// src/engine/autonomous.ts  (NEW)
export interface RunToGoalOptions {
  surface: string;
  queuePath: string;
  repoRoot: string;
  briefPath: string;
  /** PART-OR-ALL TARGETING. A subset of the brief's successCriteria ids to drive toward.
   *  DEFAULT (undefined) = ALL required ids.
   *  - validated against real criterion ids (see below) — an unknown id is a typed terminal reason, never a silent drop;
   *  - reduced over by `goalMet` (the engine drives the WHOLE set OR any SLICE);
   *  - never lets an unconfirmed brief terminate (§4.2);
   *  - a resolved target with zero REQUIRED criteria refuses to report success (see point 4). */
  targetCriteria?: string[];
  // --- runaway guards (REQUIRED, unchanged) ---
  maxIterations?: number;     // default 5
  maxWallClockMs?: number;
  costCeiling?: number;       // compared via overBudget()
  // --- drain pass-through ---
  drainOpts?: Partial<DrainOptions>;  // n, breaker, land, landBranch, …
}

export type RunToGoalReason =
  | "already-satisfied"
  | "goal-fully-met"                     // target == ALL required AND every required criterion passes
  | "target-slice-met"                   // a strict subset / a target containing required:false ids met (NOT the whole star)
  | "machine-criteria-met-pending-human" // milestones present → stop-and-ask (never claim full success)
  | "cap-hit"
  | "breaker-tripped"
  | "no-progress"
  | "queue-empty-goal-unmet"
  | "brief-unconfirmed"                  // count-bounded fallback engaged (§4.2)
  | "invalid-target"                     // unknown targetCriteria id — refuse-to-run, typed, not a throw
  | "target-has-no-required-criterion";  // resolved target contains zero required criteria — refuse success

export interface RunToGoalResult {
  goalMet: boolean;
  iterations: number;
  reason: RunToGoalReason;
  built: number;
  /** The RESOLVED target ids actually driven toward (all-required when targetCriteria omitted). */
  target: string[];
  /** Required criteria still failing at stop (drives the honest notify line). */
  failingRequired: string[];
}

export async function runToGoal(
  opts: RunToGoalOptions,
  deps: RunToGoalDeps,            // { loadBrief, evaluateCheckSpec, runDrain, runAudit, notify, emitPark, now }
): Promise<RunToGoalResult>;
```

**Target resolution & validation (the new, load-bearing part):**

1. `loadBrief(briefPath)` → `{brief, status, errors}`. `status:'unparseable'` → loud signal via `emitPark` + `notify`, **no run** (the §3.1 parse-failure contract is unchanged). `status:'absent'` → no goal function; `runToGoal` cannot terminate-on-goal and degrades to count-bounded drain with `reason:'brief-unconfirmed'`-class messaging.
2. **`confirmed:true` is load-bearing (§4.2, unchanged) and OUTRANKS targeting.** While `confirmed === false`, success-termination **refuses** — `runToGoal` falls back to count-bounded behavior, returns `reason:'brief-unconfirmed'`, and notifies "brief unconfirmed; autonomous-to-goal disabled until confirmed." An unconfirmed, machine-inferred draft can never act as the goal function — and **`targetCriteria` does not bypass this**: even a perfectly-valid target slice cannot terminate against an unconfirmed brief.
3. **Validate `targetCriteria` against REAL criterion ids — typed terminal reason, never a throw (resolves v2-minor-unknown-id-throw).** Build `allIds = new Set(brief.successCriteria.map(c => c.id))`. If `targetCriteria` is supplied, **every id must exist in `allIds`** — an unknown id is a **refuse-to-run with `reason:'invalid-target'` + notify + NO run** (typed terminal reason, *not* a `throw`/stack-unwind, so the unattended path degrades safely like `brief-unconfirmed` and the explicit-empty refusal). A typo in the target must not silently shrink the goal to a passable subset (the same class of bug as the empty-set ⇒ done trap). Resolve the effective target:
   - `targetCriteria` omitted ⇒ `target = brief.successCriteria.filter(c => c.required).map(c => c.id)` (**all required ids** — the v1 default behavior, "drive the whole set").
   - `targetCriteria` supplied ⇒ `target = targetCriteria` (validated; **part** — a slice). A slice **may** include `required:false` criteria when the human explicitly aims at them; the required-coverage guard (point 4) and the empty-set guard still protect against a degenerate target.
4. **Two coverage guards — the empty-set guard is necessary but NOT sufficient (resolves v2-major-required-coverage).**
   - **Empty resolved target ⇒ refuse to run-to-goal.** If `target` is empty after resolution (e.g. an explicit `targetCriteria:[]`, or a brief with zero required criteria under the omitted default), `goalMet` would return `false` forever by the §3.2 guard — so `runToGoal` does **not** spin: it returns immediately with `reason:'target-has-no-required-criterion'`-class "nothing to drive toward" + a human notify.
   - **Zero-required-criterion target ⇒ refuse success.** The empty-set guard does **nothing** for the dangerous case where `targetCriteria` is *non-empty* yet every resolved id is `required:false` (e.g. aim at an optional `file-exists` doc check). `goalMet` would see a non-empty set, all pass, and return true — a false win while required work is still red. So: **when the resolved target contains zero `required` criteria, `runToGoal` refuses to report any `*-met` success** — it returns `reason:'target-has-no-required-criterion'` + notify, exactly as the explicit-empty target refuses. The only success that consults nothing about `required` is thereby **impossible to reach**. (The schema `.refine()` guarantees ≥1 required `command` criterion exists, so the *omitted-default* path is non-empty-and-has-required by construction; these guards only catch degenerate **explicit** targets.)
5. **Honest success terminal states — `goal-fully-met` is reserved for the WHOLE star (resolves v2-major-misleading-fully-met).** `goalMet(checked, target)` reduces purely over `target` membership and does **not** consult `required` — so the *terminal reason*, not the reducer, carries the honesty:
   - `reason:'goal-fully-met'` is returned **only when** `target == all-required` **AND** every required criterion passes. This is the strong v1 meaning: the whole north star is met.
   - `reason:'target-slice-met'` is returned for **any** strict subset of required ids, **or** any target containing `required:false` ids, when that target is met. The notify on `target-slice-met` **enumerates the still-failing required criteria** (`failingRequired`), so the loop never reports the strongest-sounding reason for the weakest possible win. A slice win is honest about being a slice.
6. **Milestone interaction is pinned to GLOBAL stop-and-ask (resolves v2-major-milestone-scope).** `milestones` is a brief-level array with no association to `successCriteria` ids, so v2 chooses the unambiguous option (a): **ANY milestone-bearing brief always yields `reason:'machine-criteria-met-pending-human'` regardless of the target**, and **never** `goal-fully-met` or `target-slice-met` from the machine alone. This precedence is explicit: *milestones-present outranks target-met* — when a milestone exists, the targeted machine criteria passing does **not** auto-terminate; it parks via `emitPark` and stops-and-asks. **Documented consequence (so callers are not surprised):** while any milestone is open, sliced *and* whole autonomous-to-goal is effectively gated on the human — `runToGoal` will park rather than declare done. (We deliberately do **not** scope milestones to a slice's territory in this epic — milestones carry no criterion association to scope against; revisit only if a real association field is added. This keeps `## Parked` honest: a milestone is a human judgment the machine must not pre-empt.) To avoid this becoming a *repeated* park nag, the milestone stop-and-ask obeys the same rate-limit as §5.5 (no new park while one is already parked for the same brief).
7. The resolved `target` (a `Set<string>`) is what every `goalMet(checked, target)` call reduces over, what `briefSatisfied(brief, target)` early-stops on, and what the no-progress detector compares passing-membership across. It is also threaded into the **work-bridge**: the targeted `runAudit` pass aims at the surface(s) of the **failing target criteria**, not arbitrary surfaces.

This is the entire "PART OR ALL" surface: a caller passes `targetCriteria` (a slice) or omits it (all required). Everything downstream — `goalMet`, `briefSatisfied`, no-progress, the work-bridge — already reduces over a set, so targeting threads through cleanly without touching the rails.

#### The work-bridge (resolves R3-blocker-no-work-bridge), unchanged

When the queue empties with the target unmet, `runToGoal` does **not** invent work and does **not** spin — it runs **one targeted audit pass** (`runAudit` at the surface of the *failing target criteria*) to enqueue findings; if that produces nothing claimable, it **stops** with `reason:'queue-empty-goal-unmet'` and notifies a human. (The MVP-safe variant — never re-audit, just "drain the queue then report goal status" — is the fallback if the audit bridge is descoped; the spec picks the audit bridge but flags it as the heavier path.)

**Unsatisfiable-target notification (resolves v2-minor-unsatisfiable-target).** When `cap-hit` fires with the target still partially failing **AND** the failing-criteria set was **constant across the run** (a wide slice kept making progress on some ids while one targeted criterion is structurally unreachable — e.g. a `file-exists` on a path no queued/audited work will ever create), the no-progress detector never trips (the passing-set grows each iteration) and the run only stops at the cap. That is the caps doing their job (safe), but the terminal `notify` must **flag it as a likely unsatisfiable/over-specified target** (carrying the constant `failingRequired` set) rather than a generic `cap-hit`, so the human fixes the brief instead of just re-running.

#### What part-or-all targeting must NOT relax (rails preserved verbatim)

- **The empty-set guard stays** (`goalMet([...], ∅) === false`). Targeting changes *which* set is passed, never the vacuous-truth answer. It is **necessary but not sufficient** — paired with the zero-required-criterion refusal (point 4).
- **The caps stay required:** `maxIterations=5`, `maxWallClockMs`, `overBudget` cost ceiling — a sliced target does not get to run longer or cheaper-unbounded.
- **The no-progress K=2 stall stop stays, distinct from the failure breaker** — it now reduces over the *target* passing-set so a slice run can still detect "green but not advancing *the slice*."
- **The command-criterion `.refine()` stays** (§3.2): a slice can only ever target ids that exist, and the brief as a whole is structurally required to carry ≥1 required `command` criterion before it loads.
- **Human-gated brief writes stay (INV-A):** `runToGoal` imports **no** brief writer; it only `loadBrief`s and evaluates. Any milestone-reflection brief-update it triggers routes through `emitPark`/sinks (§4.3) — never `writeFileSync(briefPath, …)`.
- **The milestones stop-and-ask stays and OUTRANKS target-met:** any `milestones` present ⇒ `machine-criteria-met-pending-human` + park; it **never** claims `goal-fully-met` or `target-slice-met` from the machine alone, even when the targeted machine criteria all pass (point 6).
- **The success-reason split stays:** `goal-fully-met` ⟺ whole star met; `target-slice-met` ⟺ a slice met (with the failing-required notify). A slice win can never masquerade as the whole star (point 5).
- **The required-coverage guard stays:** a target with zero required criteria refuses success (point 4).
- **The work-bridge stays** (no inventing work, no spinning on an empty queue; one targeted audit pass then stop-and-notify).
- **The unconfirmed-brief gate stays** and **outranks targeting** (point 2).

(Per the personal-projects scope boundary §1: this is built for **one owner's personal projects** — the caps and the single-human park-gate are the whole governance model; there is deliberately no multi-stakeholder sign-off on a target slice.)

### 5.5 Digest / reflection (Loop C — scope c)

| File | Function / line | Change |
|---|---|---|
| `src/engine/digest.ts` | new exports beside `formatRecord`/`appendDigest` | Add `interface ReflectionRecord { milestone; learned: string[]; briefStillValid: boolean; onPath: boolean; driftedCriteria?: string[]; proposedUpdate?: string; proposedConventions?: string[]; proposedGlossary?: GlossaryEntry[] }` + pure `formatReflection(r)` + `appendReflection(logPath, r)` mirroring the `formatRecord`/`appendDigest` Bun.file read-append-write shape. **Do NOT extend `DigestRecord`** — its **6-field** schema (`item, manifestHash, reviewVerdict, deployResult, anomalies, questionsAsked`) is frozen and asserted field-by-field in `src/engine/verify/__tests__/digest.test.ts`. |
| `src/engine/design-run.ts` / `src/engine/autonomous.ts` | the **explicit milestone** trigger | **Milestone is pinned (resolves R1-major-milestone, Q5):** the `proposedUpdate` path (including `proposedConventions`/`proposedGlossary` growth) fires **only** on an explicit milestone marker — epic completion or an explicit `--milestone` flag — **not** on every `runFeatureDesign` land. A per-feature land may `appendReflection` a *lightweight* note (`learned`/`onPath`, no `proposedUpdate`). The proposal path is additionally **rate-limited**: no new `proposedUpdate` if one is already parked awaiting human review. Conventions/glossary growth is **batched into the single `proposedUpdate`** (not separate park entries per term). This prevents the "propose-a-brief-change-after-every-feature" rubber-stamp drip and keeps `## Parked` rare (resolves v2-major-grown-nag). |
| (propose path) | — | `proposedUpdate`/`proposedConventions`/`proposedGlossary` are **TEXT/DATA ONLY**, written to the run log via `appendReflection` **and** staged via `emitPark`/sinks (§4.3). **No path** to `writeFileSync(briefPath, …)` (INV-A). The no-write rail is tested across **both** the reflection path *and* the drain/digest paths, **including a case where the proposedUpdate is a conventions/glossary addition** (resolves R1-blocker-2, v2-minor-growth-rail). |

### 5.6 Doctrine surfaces (prose backing the tested teeth)

- `src/engine/decisions.md` `## Active`: two `[decision]` entries — (1) "A brief/north-star update is a judgment-zone change — PROPOSE it via park/sink (human-gated), never silently rewrite the vision to fit a misaligned ask; this includes conventions/glossary growth"; (2) "Warn on MATERIAL (core-scope) drift only — offer reshape/update via the propose path, NEVER block."
- `src/engine/lessons.md` `## Active`: one `[rail]` entry — "the brief is written only by `seedBriefIfAbsent`/`writeConfirmedBrief` (the two human-present entry points); the design/audit/drain/digest stages export and import no brief writer" (codifies INV-A per the line-57 discipline that an autonomous-door rail must be tested code, not prose).
- `plugins/thebashway/skill/SKILL.md`: add the north-star section to the method — (init creates+infers, incl. conventions/glossary; agent runs the **non-technical, progressive, three-ring** conversational interview after init, mapping plain answers to the schema and **translating the success answer into a candidate `command`** or routing it to `milestones`; build/audit refer to the brief; autonomous mode runs `runToGoal` part-or-all). Add operating rules: brief is LIVING but updates are PROPOSED/human-gated and **throttled to milestone markers**; the alignment warning is advisory and never blocks; real bugs are never gated on the vision; an unfilled `command` placeholder is an expected cold-start state that only disables autonomous-to-goal.

## 6. The drift warning — keep the project on its core scope

`classifyDrift(design, brief, sensitivity)` is deterministic over **structured** fields (no prose-vs-prose matching). **Its one job: catch a designed feature that contradicts the project's core scope** — out of `inScopeSurfaces`, in `forbiddenSurfaces`, or in `forbiddenTerritory`. That is what "material drift" *means* here; everything below is the calibration of that single core-scope test.

- `'off'` → always `{material:false}` (kill switch). **Unconfirmed brief is forced to `'off'`** (§4.2).
- `'low'` → fires only when `design.surface ∈ brief.forbiddenSurfaces` **or** `design.affectsTerritory ∩ brief.forbiddenTerritory ≠ ∅` (an outright limits/forbidden core-scope contradiction).
- `'medium'` (default) → also fires when `brief.inScopeSurfaces` is non-empty **and** `design.surface ∉ inScopeSurfaces` (designed outside the declared core scope).
- `'high'` → also fires on a partial territory overlap with a forbidden glob (a minor stretch toward out-of-scope).

Only when Tier 1 returns `material:true` does the optional LLM Tier 2 (`runAlignmentCheck`) fire — so warnings are **rare by construction** and model cost is gated. Where the brief has no structured scope fields (a thin draft), Tier 1 is honestly a coarse pre-gate (`brief present AND confirmed AND sensitivity≠off`) and the calibration burden sits on Tier 2 + a Loop-B `[brief]` lesson — the spec **does not** claim deterministic teeth over free text (resolves R1-minor-freetext, R2-blocker-input honesty clause).

**The offer (honestly framed — resolves R2-minor-inline).** In an **autonomous** run there is no human present, so the offer is a **logged annotation + a single `notify` line + (only for genuinely human-needing core-scope contradiction) one `emitPark` entry**; the build proceeds (build-anyway is the de-facto path). In an **interactive** run the agent surfaces reshape / update-brief / build-anyway as a next-step choice. The word "inline" is dropped; the reshape/update path is always the §4.3 human-gated propose flow. The park entry is emitted **only** for the rare material-drift-needing-a-human case, never on every drift — or `## Parked` becomes the new nag surface. (The conventions/glossary growth path and the milestone proposal path are throttled to the same rare-park discipline — §3.2 rule 3, §5.5 — so the three streams together cannot dilute `## Parked`.)

**The guarantee it never blocks.** There is **no code path** from a drift verdict to `report.aborted`, to `status:'needs-intake'`, or to a `break` in any loop. It layers strictly **after** `classifyIrreversible` and the PARK rail and can never relax them: an "aligned" verdict can **never** let a person-reaching/destructive task through (alignment only *adds* an advisory signal, never *writes* status). The only hard loop-stops remain `shouldTrip` (breaker), the PARK rail, and the opt-in `goalMet` success-termination (which stops because the goal is **met**, not because an ask is off-scope).

## 7. Delivery — one epic, dependency-ordered build (a → b → d → c)

This ships as **one epic, all four parts**, built in the dependency order **a → b → d → c**. There is no MVP cut and no deferral: (c) milestone reflection and (d) autonomous part-or-all termination are **first-class members of this epic**, not "later." The order is chosen so each part pays down the risk of the one that follows.

**(a) Schema + init infer-and-confirm + intake-feed — FIRST.**
`src/engine/brief.ts` (`DesignBriefSchema` incl. the `command`-requiring `.refine()`, `CheckSpecSchema` with `timeoutMs`, the lean `conventions`/`glossary` fields + `GlossaryEntrySchema`, the **bounded** `renderBriefForPrompt`, `classifyDrift`); `loadBrief` IO wrapper + parse-failure loud-signal contract; `LearningBinding.brief` + `RailsBinding.briefDriftSensitivity` both resolved-with-default in the **single** `defineThebashway` spread + `getBriefPath()`/`getBriefSensitivity()` accessors (reset in `resetBinding`) + both example configs (lifeofbash → `tools/orchestrator/brief.ts`) + `derivePaths` `briefPath`; `init.ts` `seedBriefIfAbsent` (the only writer) + `gatherBriefInputs` (create-path only, infers `conventions`/`glossary` from `package.json` scripts, README, existing test/deploy patterns) + `inferBriefDraft` + `BRIEF_SEED` + `InitResult.briefCreated/briefGaps` + `initMessage` nudge + `configTemplate` emits the path; CLI `cmdBrief` (non-interactive); SKILL.md non-technical progressive interview prose (three rings + the success-question translation duty) + decisions.md/lessons.md doctrine; the brief threaded into `buildIntakePromptFromDisk` as the stable layer above `decisions.md` (with the UNCONFIRMED-marking + owner-name genericization).

**Why first:** (a) is the schema spine. The risky part of (d) — an un-terminable or trivially-terminable brief — is **a hard schema invariant in (a)** (the discriminated union + the `command`-requiring `.refine()` + the not-trivially-met seed). **(a) pays down (d)'s schema risk before (d) is written.** Get the criterion set provably-machine-checkable up front, and (d) becomes thin wiring of an already-validated set into a pure reducer, a tested evaluator, and one capped driver.

**(b) The design-door alignment gate — SECOND.**
`FeatureDesignSchema.affectsTerritory` (the structured drift input); brief injection through `buildIntakePromptFromDisk` into the design stages **and** the audit shaper (the 3 callsites of §6 Risk 6 / §5.2); the deterministic `classifyDrift` Tier 1 + optional Tier 2 + `DesignReport.alignment` surfaced advisory-only; the audit side is **prompt-context-only** (no new gate — §5.3); `briefDriftSensitivity` honored incl. unconfirmed→off.

**Why second:** (b) is where the brief first *guides* a real run — design context + the core-scope drift warning — with a human still in the loop and **no autonomous wheel turning yet**. **(b) proves the brief actually guides the build correctly before (d) hands the same brief the authority to terminate the loop.** If the brief can't steer a single supervised design, it has no business driving an unsupervised run. The autonomous design door also has no human reading prose, so shipping the *structured deterministic* pre-filter here (not a prose-only nudge) gives the warning real teeth from day one and ships conservative so it can't nag.

**(d) Autonomous part-or-all termination — THIRD.**
`evaluateCheckSpec` (+ Runner timeout), `breaker.ts` `goalMet` (the pure reducer, empty-set → false), `drain.ts` `briefSatisfied?`/`stopWhenBriefMet`/`targetCriteria`/`goalMet`, and the **named** `src/engine/autonomous.ts` `runToGoal` with its **required** caps (`maxIterations`=5, `maxWallClockMs`, the `overBudget` cost ceiling), the no-progress K=2 stall detector, the work-bridge, and the explicit terminal-state set. **Part-or-all targeting:** `runToGoal` gains `targetCriteria?: string[]` (a subset of success-criterion ids; **DEFAULT = all required**); `goalMet` reduces over **that target set** (the empty-set → false guard stays); aim the engine at a *slice* (part) or the *whole* set (all). `targetCriteria` validates against real criterion ids (unknown → `invalid-target` refuse-to-run), refuses a zero-required-criterion target, splits `goal-fully-met` (whole star) from `target-slice-met` (a slice, with failing-required notify), and never lets an unconfirmed brief terminate (§4.2). The optional `'maintenance'` audit gate (§5.3 last row) rides with this wave if wanted. The `cmdRunToGoal` CLI entry (`--target`) lands here.

**Why third:** (d) depends on (a)'s validated criterion set and on (b) having proven the brief guides correctly. With both in hand, (d) is the wiring of an already-trustworthy goal-set into a capped driver — the heaviest *machinery*, but the lightest *remaining design risk* because the hard invariants were paid down upstream.

**(c) Milestone reflection — LAST (smallest).**
`digest.ts` `ReflectionRecord`/`formatReflection`/`appendReflection` (incl. the `proposedConventions`/`proposedGlossary` carriers) + the explicit-milestone `runReflect` pass + rate-limited, batched propose-via-park staging.

**Why last:** (c) is the **smallest** part — an additive digest seam plus a human-gated propose path that reuses the §4.3 `emitPark`/sinks mechanism wholesale. It touches nothing in (a)/(b)/(d) and reopens nothing; it is pure addition on top of a settled goal function. It goes last precisely because it is the cheapest and the most isolated — there is no reason to spend its risk budget before the load-bearing parts are proven.

**Order rationale in one line:** *a pays down d's schema risk; b proves the brief guides before the autonomous wheel is handed the goal; d wires the proven goal-set into one capped driver; c is the smallest, most-isolated addition and rides last.*

**Single-epic safety note.** Because (c) and (d) are committed in the same epic (not gated behind a "ship a+b, learn, then decide" checkpoint), the safety surface of (d) MUST be in place **at delivery**, not incrementally: every cap (`maxIterations=5`/`maxWallClockMs`/`overBudget`), the no-progress K=2 stall, the milestones→`machine-criteria-met-pending-human` stop-and-ask, the `confirmed:true` gate, AND the new targeting guards (`invalid-target`, zero-required-criterion refusal, `goal-fully-met`/`target-slice-met` split) are **required, not optional**. The dependency order is what makes this safe to ship in one epic: (a) still pays down (d)'s schema risk before (d) is built, and (b) still proves guidance before autonomy.

## 8. Test plan (`bun:test`, existing `__tests__` layout)

> Test dirs confirmed: pure-logic tests live under `src/engine/verify/__tests__/` (**not** `engine/__tests__/`, which holds only `audit`/`lesson-inject`/`worktree-spawn`); cold-start tests under `src/__tests__/`. **The `getRepoRoot`/`getDefaultSurface` set/restore assertions live in `portability.test.ts:42–46`, not `config.test.ts`** (corrects the draft). Tools-surface gate chain is `[test, validate]` with **no tsc** — run `bunx tsc --noEmit` by hand after touching engine code.

**(a) Schema + storage + init — `src/engine/verify/__tests__/brief.test.ts` (new), `src/__tests__/init.test.ts`, `binding.test.ts`, `portability.test.ts`:**
- `brief.test.ts`: `DesignBriefSchema` parses a full brief; `.refine()` **rejects** a brief whose only required criterion is `{kind:'verify'}` or `{kind:'file-exists'}` (must have a required `command`); `CheckSpec` rejects unknown `kind` and free-text checks. `loadBrief` of an **existing-but-broken** module returns `status:'unparseable'` (not silent null) — assert the loud-signal contract. **`confirmed:false` → `classifyDrift` returns `material:false` regardless of sensitivity** (the confirmed-invariant).
- **NEW — `conventions`/`glossary` schema:** `conventions` and `glossary` parse as typed arrays with `.default([])` (a brief with neither field still parses; `GlossaryEntry` requires `term`+`means`); the new fields **never affect** `.refine()`/terminability (a brief with a 50-bullet `conventions` and the seed `command` placeholder still loads exactly as one with `conventions:[]`).
- **NEW — `renderBriefForPrompt` is BOUNDED:** a brief with a 100-entry `conventions` array and a 100-entry `glossary` renders a **bounded** prompt block — only the top-N/top-M plus a `+K more` note — assert the rendered length is bounded and does not scale with array size (resolves v2-minor-render-cap). Also assert it is compact (does not dump the whole doc) and **marks gap/unconfirmed fields as `DRAFT/UNCONFIRMED`** when `confirmed:false`.
- `init.test.ts`: `seedBriefIfAbsent` **creates** `brief.ts` and is **idempotent**; on the idempotent re-run `gatherBriefInputs` is **not** called (no extra git/file I/O — assert via a spy/no-spawn). `inferBriefDraft` pre-fills purpose from a fixture README/`package.json` and records `# GAP`s; **seeds `conventions` from a fixture `package.json` `scripts` block** (e.g. a `test` script → a testing-norm bullet) and records `# GAP: glossary` when no confident term is found; empty-repo fixture → `BRIEF_SEED` with `conventions:[]`/`glossary:[]` + the `verify`(required:false)+`command`(placeholder) criteria → loads but is **not** trivially terminable. `InitResult.briefCreated/briefGaps` populated; `initMessage` mentions `thebashway brief`.
- `binding.test.ts`: the `minimal` fixture still resolves — `defineThebashway` defaults `brief` and `briefDriftSensitivity` **without** the :140 guard throwing; assert both defaults present in the resolved object.
- `portability.test.ts`: both example configs stay green with the new optional fields; add the `getBriefPath()`/`getBriefSensitivity()` **set-by-`setBinding`, restored-by-`resetBinding`** assertions **here** (beside the existing `getRepoRoot` ones), asserting no cross-contamination after reset.

**(b) Alignment gate — `brief.test.ts`, `design.test.ts`, `audit-run.test.ts`, `intake-prompt.test.ts`:**
- `classifyDrift` (table-driven over structured fields): `'off'` → always false; unconfirmed → false; `'low'` fires on a `forbiddenSurfaces`/`forbiddenTerritory` hit and **only** then (an in-scope design → false, no nagging); `'medium'` fires on out-of-`inScopeSurfaces`; `'high'` on partial overlap.
- **Drift never blocks (rail test):** a design with `classifyDrift.material===true` yields `DesignReport.alignment.material===true` but `report.aborted===false` and **no task forced `needs-intake`**; run proceeds.
- **Alignment never relaxes PARK (rail test):** a person-reaching/destructive design deemed "aligned" still parks via `classifyIrreversible`.
- **Real bugs unconditional (rail test):** a `kind:'correctness'` finding advancing no criterion stays build-ready; the brief is **never** consulted for correctness findings. **Audit non-increase test:** the audit change does **not** raise the `needs-intake` count for `kind:'design'` findings (R2-major-audit-noop).
- `intake-prompt.test.ts`: passing `brief` prepends the North-star block before decision-defaults; omitting it leaves output byte-identical. **NEW — graceful degrade:** an **unconfirmed/thin** brief is injected but its gap/unconfirmed fields render marked `UNCONFIRMED` (assert the marker appears) — so the stable layer does not present a guessed scope as authoritative (resolves v2-minor-thin-intake-degrade). **NEW — directional label:** the injected block label is the directional "North star — build toward this:" (no in-prompt "flag drift" instruction; the drift flag is the separate `classifyDrift` step) and the LEARNED-layer owner name is genericized/parameterized (no hard-coded "Bashir" — resolves v2-minor-owner-leak, v2-minor-label-double-count).

**(c) Reflection — `src/engine/verify/__tests__/digest.test.ts`:**
- `DigestRecord` 6-field schema unchanged (existing assertions pass). `formatReflection`/`appendReflection` append a block.
- **No-auto-write rail test (the single most important test):** a `ReflectionRecord` with `proposedUpdate` causes **zero** `writeFileSync`/`Bun.write` to `briefPath` — only the log + the park/sink artifact. Spy the brief path; assert zero writes **across reflection AND drain/digest paths**. **NEW — growth rail:** include a case where the `proposedUpdate` carries a **`proposedConventions`/`proposedGlossary` addition**, asserting **zero** writes to `briefPath` and that the only artifacts are the run log + the park/sink entry (resolves v2-minor-growth-rail — the field a future contributor is most tempted to auto-append is test-pinned to the no-write rail). Plus: `proposedUpdate`/growth only on the explicit `--milestone`/epic marker, growth **batched into the single proposal** (not per-term parks), and rate-limit suppresses a second proposal while one is parked.

**(d) Termination — `breaker.test.ts`, `brief.test.ts` (evaluator), `drain.test.ts`, `autonomous.test.ts` (new):**
- `goalMet`: all-target pass → true; any target fail → false; **empty target → false** (the vacuous-truth guard). **Strict-subset target: a 2-of-5 slice returns true when those 2 pass even though the other 3 fail; the same slice returns false if one of the 2 fails.** Pure, table-driven.
- `evaluateCheckSpec` (fake Runner): `command` exit-0 → pass, non-zero → fail, **timeout → fail**; `file-exists` true/false; `verify` delegates to the chain. Decision logic unit-tested; only real-process wiring un-tested.
- **`runToGoal` targeting (NEW):**
  - `targetCriteria` with an **unknown id** → `reason:'invalid-target'`, **no run**, notify (typed terminal reason, not a throw — resolves v2-minor-unknown-id-throw).
  - **omitted `targetCriteria`** ⇒ resolved target = all required ids; full-pass → `reason:'goal-fully-met'`.
  - **explicit `targetCriteria:[]`** ⇒ refuse-to-run, no spin, `reason:'target-has-no-required-criterion'`-class.
  - **strict-subset slice met** ⇒ `reason:'target-slice-met'` (NOT `goal-fully-met`) and the notify enumerates the still-failing **required** criteria (resolves v2-major-misleading-fully-met).
  - **target of only `required:false` ids, all passing** ⇒ refuse success: `reason:'target-has-no-required-criterion'` + notify, **never** a `*-met` reason (resolves v2-major-required-coverage / Finding-1+3).
  - **a slice that is already satisfied at entry** → `reason:'already-satisfied', built:0` even though untargeted criteria fail.
- **`runToGoal` rails (unchanged + milestone-scope pin):** `maxIterations` cap → `cap-hit`; no-progress (target passing-set unchanged) → stop after K=2 stalls; **a brief with ANY `milestones` entry NEVER reports `goal-fully-met` or `target-slice-met` from the machine path — it reports `machine-criteria-met-pending-human` and parks, even for a pure-`command` slice unrelated to the milestone** (resolves v2-major-milestone-scope — milestone outranks target); **unconfirmed brief → `reason:'brief-unconfirmed'`, count-bounded, never terminates on the goal even with a valid `targetCriteria`** (unconfirmed outranks targeting); **`cap-hit` with a constant failing-required set across the run → notify flags likely unsatisfiable/over-specified target** (resolves v2-minor-unsatisfiable-target).
- `drain.test.ts`: seam **omitted** → all existing fakes pass (back-compat). With `stopWhenBriefMet:true` + a `briefSatisfied` fake true after first integrate → `report.goalMet` set, `break` without a new claim, **landFn still runs on green**. **`targetCriteria` on `DrainOptions` is threaded into `briefSatisfied`'s `target` arg.** The `allowTitles` design-door drain ignores `stopWhenBriefMet`. Breaker + `unsafeIntegrationBranch` still trip regardless.

## 9. Open questions for Bashir + Risks

### Open questions (the gaps the interview itself would ask; the previously-deferred design decisions are now resolved in-spec and noted)

1. **(brief content, every repo)** Purpose / why now / who we're really serving for *this* repo? (init infers a draft; the non-technical interview confirms — Ring 1.)
2. **(success — load-bearing, non-technical-safe)** Beyond "verify chain passes," what would *prove* the north star is met — what would you look at / click / see? The agent translates the plain answer into a candidate `command` (or routes it to `milestones`); the `.refine()` requires a `command` criterion and the seed ships a `# GAP` placeholder. **Confirm:** an unfilled placeholder is an accepted cold-start state (brief loads + guides; only autonomous-to-goal stays disabled until a developer fills it).
3. **(scope/limits)** What surfaces/territory are explicitly **out of scope** (`forbiddenSurfaces`/`forbiddenTerritory`) and **in scope** (`inScopeSurfaces`)? These structured fields are what `classifyDrift` tests against.
4. **(conventions/glossary — NEW)** Confirm the inferred how-we-work bullets and domain terms (Ring 2), and that growth thereafter is **milestone-throttled + human-gated + batched** (not a per-build drip). Confirm the `renderBriefForPrompt` render caps (top-N conventions / top-M glossary) fit your taste.
5. **(autonomous caps — RESOLVED in-spec, value confirm)** `runToGoal` ships with `maxIterations` default **5**, a `maxWallClockMs`, an `overBudget` cost ceiling, and a no-progress stop at **K=2** stalls. Confirm the default values fit `bashir-cost-sensitive`. `goalMet([], ∅)` returns **false** (decided).
6. **(part-or-all targeting — NEW, confirm)** Default = all required ids; `--target <id,…>` aims at a slice. A slice win returns `target-slice-met` (not `goal-fully-met`) and the notify lists still-failing required criteria; a zero-required-criterion target refuses success; any open milestone outranks target-met and forces stop-and-ask. Confirm this honesty model.
7. **(milestone — RESOLVED in-spec, confirm)** A "milestone" that may **propose a brief change** = an explicit `--milestone` flag or epic completion, **not** every feature land (per-feature lands append a lightweight note only). Confirm the marker. Confirm that any open milestone gating *all* autonomous-to-goal termination (not just milestone-relevant slices) is acceptable for personal-project scale.
8. **(binding placement — RESOLVED)** `briefDriftSensitivity` lives on `RailsBinding` (resolved in the same spread). Confirm vs a separate top-level field.
9. **(external propose surface, generic repos)** The brief-update proposal routes through `emitPark` (queue.md/NOW.md) + `sinks.eventSink`. For a generic repo with neither a board nor an external feed, is the NOW.md `## Parked` entry the sufficient human-gate, or should `init` scaffold a `.thebashway/proposals/` log the reflection appends to?
10. **(intake-feed coverage — NEW, confirm)** The brief feeds the 3 design/audit `buildIntakePromptFromDisk` callsites; `auto-intake.ts` (the `@needs-intake` promotion path) is intentionally **not** brief-fed this epic. Confirm leaving auto-intake out (vs. adding `brief?` to `BuildIntakePromptOptions` to cover it).

### Risks

1. **Rubber-stamp (deepest; design can only nudge).** If the inferred draft is good enough, the human confirms without thinking. *Mitigation:* `confirmed:false` is **load-bearing** (an unconfirmed draft never drives drift-warnings or termination), `gaps` force at least an acknowledgment pass, and milestone reflection re-asks "is the brief still valid." Inherently a human-discipline gap.
2. **Green-but-purposeless termination — structurally blocked.** The seeded `{kind:'verify'}` criterion is `required:false` and cannot alone trip `goalMet`; the `.refine()` forces a `command` criterion the seed leaves as an editable placeholder. The human still owns whether that command is *meaningful*, but the loop can no longer declare "north star met" on first-green.
3. **Sliced-target under-termination (NEW).** A caller can aim at a *slice* (`targetCriteria`), so `runToGoal` can legitimately terminate while OTHER required criteria are still red — by design (drive a part). *Mitigation:* the terminal reason is **split** — `goal-fully-met` only for the whole star, `target-slice-met` for a slice — and the `target-slice-met` notify enumerates the still-failing required criteria; the omitted default is still ALL required ids so the unspecified case keeps the strong v1 meaning; a zero-required-criterion target refuses success; INV-A keeps the engine from quietly editing the brief to make a slice look like the whole.
4. **Target-typo silently shrinking the goal (NEW, guarded).** An unknown `targetCriteria` id could shrink the target to a trivially-passable subset (a sibling of the empty-set ⇒ done trap). *Mitigation:* **unknown id → `reason:'invalid-target'` refuse-to-run** (typed, no run, no silent drop); an explicit empty / zero-required resolved target **refuses to run/report success** rather than vacuously terminating. The §3.2 empty-set ⇒ false guard remains the backstop.
5. **Gameable / flaky `command` criteria (the termination oracle).** *Mitigation:* per-CheckSpec `timeoutMs` (timeout = fail), pinned `cwd: repoRoot`, the testable `evaluateCheckSpec`, the no-progress stall detector, and the iteration/cost caps bound any runaway. Criteria are brief edits → human-gated. Same trust model as the verify chain.
6. **No-progress detector scoped to the slice (CHANGED).** The K=2 stall detector compares the *target* passing-set, so a slice run won't stall just because untargeted criteria are stuck (correct), but stall sensitivity now depends on target size. *Mitigation:* the caps (`maxIterations=5`, wall-clock, `overBudget`) are the absolute backstop regardless of target size, and a constant-failing-required-set at `cap-hit` is flagged as likely unsatisfiable rather than a generic cap-hit.
7. **conventions/glossary bloat / prompt-fattening (NEW).** The two new arrays thread through `renderBriefForPrompt` → the 3 design/audit callsites, so unbounded growth would fatten every prompt. *Mitigation (structural, not prose-only):* `renderBriefForPrompt` **caps** rendered conventions/glossary (top-N/top-M + `+K more`), inferred-only seed (no invented glossary meanings — unconfident terms become gaps), human-gated + **milestone-throttled + batched** growth (a natural brake), and the explicit "pointers not a tome" design constraint. Tested by the bounded-render assertion.
8. **`classifyDrift` calibration.** Now tested against **structured** fields (not prose), so it is honestly deterministic where those fields exist; where they're thin it degrades to a coarse Tier-1 pre-gate with the judgment on Tier-2 + a Loop-B lesson. The `'off'`/`'low'` escapes + the binding knob are the relief valve.
9. **`## Parked` dilution / nag (NEW surface, guarded).** Three streams can now park: rare material-drift, milestone `proposedUpdate`, and conventions/glossary growth. *Mitigation:* all three obey the same discipline — milestone-marker-only firing, batched into one proposal, and the "no new proposal while one is parked" rate-limit — so `## Parked` stays rare (§3.2 rule 3, §5.5, §6).
10. **Rail entanglement (structural-correctness).** Each separation has a dedicated test (§8): `goalMet`/`stopWhenBriefMet` gate claims only; `classifyDrift` never aborts/parks-as-blocker; the audit change never increases `needs-intake`; the reflection proposal (incl. conventions/glossary growth) never writes `brief.ts` or pushes main; alignment layers after `classifyIrreversible`; `target-slice-met` can never masquerade as `goal-fully-met`; milestone-present and unconfirmed-brief both outrank target-met.
11. **N-callsite injection cost (honest).** Brief injection is **3** edits (design-run.ts:406, :430, audit-run.ts:372) — `runReview` (design-run.ts:437) builds its prompt inline and is **not** a `buildIntakePromptFromDisk` callsite. The option is added once to `buildIntakePromptFromDisk`; each callsite is a one-line `briefPath` pass-through. Budgeted, not hidden.
12. **Back-compat / portability.** `brief`/`briefDriftSensitivity` are optional-with-default, resolved in the spread (not the :140 guard), in both example configs, and `resetBinding` restores the new accessors. `buildIntakePromptFromDisk`'s `brief?` is additive (omitting it is byte-identical). Covered by `binding.test.ts` + `portability.test.ts` + `intake-prompt.test.ts`.
13. **Single-epic commitment (NEW).** (c)+(d) ship in the same epic rather than behind a learn-then-decide checkpoint, so (d)'s full safety surface must be present at delivery. *Mitigation:* the dependency order ((a) pays down (d)'s schema risk; (b) proves guidance before autonomy) plus every cap/guard restated as **required** (§7 single-epic safety note).

---

## Review resolution

### v1 review resolution (preserved)

**R1 — rubber-stamp / hold-firm #1**
- **[blocker] propose-routing wired to a non-existent `proposals/` mechanism** → **Resolved.** Routed to the engine's real, tested human-gate: `emitPark` (queue.md `@parked` + NOW.md `## Parked — needs your call`) + `sinks.eventSink`/`notify` (binding.ts `SinkBinding`). The false "existing proposal mechanism" claim is dropped (§2 #1, §4.3, §5.4 driver, §5.5).
- **[blocker] "never writes brief.ts" is test-only, engine has the write primitive** → **Resolved structurally (INV-A).** `brief.ts` exports **no** writer; the only two writers (`seedBriefIfAbsent`, `writeConfirmedBrief`) live in the human-present cold-start layer; design/audit/drain/digest cannot import a brief writer. No-write rail tested across reflection AND drain/digest paths; backed by a `lessons.md` `[rail]` entry (§1.1, §5.5, §5.6, §8c).
- **[major] unconfirmed brief silently becomes the goal function** → **Resolved.** `confirmed:true` made load-bearing: unconfirmed → `classifyDrift` forced `'off'`, and `runToGoal` refuses to terminate on it (§4.2, tested §8a/§8d).
- **[major] YAML format with no parser / miscited precedent** → **Resolved (INV-B):** dropped YAML/markdown-parse entirely; brief is a `brief.ts` module `export default`ing a zod object, loaded by dynamic `import()` (the `loadBinding` precedent). Parse-failure emits a loud signal, never silent null (§1.1, §3.1).
- **[major] milestone trigger under-defined → propose-drip** → **Resolved.** `proposedUpdate` only on an explicit `--milestone`/epic marker (per-feature lands get a lightweight note only), plus rate-limiting while a proposal is parked (§5.5, §8c).
- **[minor] classifyDrift over free-text** → **Resolved** by adding structured brief fields + `FeatureDesign.affectsTerritory`; honest coarse-pre-gate fallback where fields are thin (§3.2, §5.2, §6).

**R2 — friction**
- **[blocker] CLI cannot hold the interview → questionnaire** → **Resolved.** Interview moved to the interactive agent (SKILL.md prose), now a non-technical, progressive, three-ring interview; CLI `cmdBrief` does non-interactive seed/print/suggest only (§4.1 Stage 2).
- **[blocker] classifyDrift input contract doesn't exist** → **Resolved.** Added `FeatureDesignSchema.affectsTerritory` (new structured field) + structured brief scope fields; `design.surface` already exists. No prose matching (§5.2, §6, §8b).
- **[major] audit deprioritization is a no-op** → **Resolved by honesty.** Audit = prompt-context-only (design findings already parked, correctness off-limits); the deterministic gate is named as dependent on a `maintenance` kind and rides with (d) if wanted. Non-increase test added (§5.3, §8b).
- **[major] "run until done" silently becomes "run until queue empties"** → **Resolved.** Renamed in-drain flag to `stopWhenBriefMet` (early stop only); the real looping is the named `runToGoal` with explicit terminal states distinguishing goal-met / queue-empty-goal-unmet / cap-hit (§5.4).
- **[major] green-but-purposeless termination from the seed** → **Resolved.** `.refine()` requires a `command` criterion; the seeded `verify` criterion is `required:false`; seed ships a not-yet-satisfied `command` placeholder (§3.2, §4.1, Risk 2).
- **[minor] "inline choices" oversell** → **Resolved.** Reframed: autonomous = logged annotation + notify + rare park; interactive = agent next-step; "inline" dropped; park only on human-needing material drift (§6).
- **[minor] init latency on every run** → **Resolved.** Inference I/O gated behind the `!existsSync` create check; idempotent re-runs do zero extra work (§4.1, §8a).

**R3 — termination-viability**
- **[blocker] no hook for "run until goal met"** → **Resolved.** New first-class `src/engine/autonomous.ts` `runToGoal` re-invokes drain; the in-drain break is just an early-stop optimization (§5.4).
- **[blocker] no work-bridge (loop spins on empty queue)** → **Resolved.** `runToGoal` runs one targeted `runAudit` pass at failing criteria's surface to enqueue work; if nothing claimable, stops with `queue-empty-goal-unmet` + notify. MVP-safe "drain-then-report" fallback documented (§5.4).
- **[major] `{kind:'verify'}` makes goal-met == tests-green-at-entry** → **Resolved.** Same `command`-required `.refine()` + `required:false` seed verify criterion; plus `runToGoal` evaluates at loop top and refuses on unconfirmed (§3.2, §4.2, §5.4).
- **[major] mixed machine + human-judged → false termination** → **Resolved.** Any `milestones` present → terminal state `machine-criteria-met-pending-human`, parks, never claims goal-met (§3.2, §5.4, §8d). v2 pins precedence: milestone outranks target-met (§5.4 point 6).
- **[major] no runaway guard; cost cap deferred to a question** → **Resolved.** Caps promoted to required (d) deliverables: `maxIterations`=5, `maxWallClockMs`, `overBudget` ceiling, plus a no-progress stall detector (K=2) distinct from the failure breaker (§5.4, §9 Q5).
- **[major] termination oracle untested, no timeout** → **Resolved.** `evaluateCheckSpec` testable behind the Runner seam; per-CheckSpec `timeoutMs` (timeout=fail) added to the Runner contract (`bunRun` has none today); cwd pinned (§3.2, §5.4, §8d).
- **[minor] goal-met-at-entry undefined terminal state** → **Resolved.** `runToGoal` checks at loop top → `reason:'already-satisfied', built:0` (§5.4, §8d).
- **[minor] `goalMet` empty-set undefined** → **Resolved.** Defined as **false** (vacuous-truth rejected); tested (§5.4, §8d, §9 Q5).

**R4 — fit-and-rails**
- **[blocker] machine-loadable parse path has no route / miscited precedent** → **Resolved (INV-B):** `brief.ts` module + dynamic `import()` + zod `safeParse`; no YAML, no hand-rolled parser (§1.1, §3.1).
- **[blocker] audit deprioritization has no carrier (no `kind`, no `maintenance`, shaper emits no kind)** → **Resolved by scoping the in-epic audit to prompt-context-only**; the deterministic gate's required schema deltas (`maintenance` kind, `briefAdvances` field, finder emission) are enumerated and named as a dependency that rides with (d), not "optional" (§5.3).
- **[major] lifeofbash brief path inconsistent with its learning-store location** → **Resolved.** `examples/lifeofbash.config.ts` → `tools/orchestrator/brief.ts`; `.thebashway/brief.ts` only the fresh-repo default (§3.1, §5.1).
- **[major] split default-resolution (spread for path, none for sensitivity)** → **Resolved.** Both defaults resolved in the single `defineThebashway` return spread (incl. a `rails` spread that doesn't exist today) + belt-and-suspenders coalescing in the accessors (§5.1).
- **[major] `{kind:'verify'}` has no evaluation primitive; verify-as-termination unbuilt** → **Resolved.** `evaluateCheckSpec` `verify` kind delegates to `runChain(surface.chain, surface, bunRun)` (verify/index.ts:65); the evaluator is a named (d) deliverable, and the spec stops claiming termination is de-risked by `verify` until the evaluator exists (§5.4).
- **[minor] accessor tests cited in wrong file; index.ts export framing off** → **Resolved.** Accessor set/restore tests pointed at `portability.test.ts:42–46`; `getBriefPath` consumed via cli.ts's direct `./engine/config` import, no `index.ts` export claimed (§5.1, §8a).
- **[minor] `detectProject` async / "already shells git" wrong** → **Resolved.** Inference inputs gathered by a new sync `gatherBriefInputs` (git shelling actually lives in `runInit`); corrected throughout (§4.1).

### v2 review resolution (converged-design pass + second adversarial round)

**Converged-design deltas folded in**
- **Purpose reframed (Refinement #1):** brief is the living project definition / guiding light; the four purposes are **co-equal**, termination is **first-class, not a bonus** (§1).
- **Unified model (direction-vs-destination settled):** north star = the whole goal-set; autonomy targets **part or all** (§1, §5.4).
- **Brief feeds intake, honestly (Refinement #1 intake-feed, #2):** stable brief layer above learned `decisions.md`, framed as an **asymptote, not a guarantee** (§4bis).
- **Lean `conventions`/`glossary` (Refinement #3):** inferred-first, confirmed-in-interview, grown-via-human-gated-proposal, bounded at render (§3.2, §4.1).
- **Non-technical progressive interview (Refinement #5):** three rings, plain-language, schema-mapped behind the scenes (§4.1 Stage 2).
- **Autonomous mode first-class + part-or-all (Refinement #6):** `runToGoal` with `targetCriteria`, in this epic (§5.4).
- **One epic, dependency-ordered a→b→d→c (Refinement #7):** replaces the v1 MVP/defer split (§7).
- **Scale = personal projects, no enterprise governance (Refinement #8):** stated scope boundary (§1, §7, §9).

**Lens — conventions/glossary growth vs INV-A**
- **[minor] stale `brief.md` filename in INV-A / §2 #1** → **Resolved.** Every remaining `brief.md` replaced with `brief.ts` throughout (§1.1, §2 #1).
- **[minor] growth path not pinned to the no-write rail test** → **Resolved.** §8c no-write rail test extended with a case where the `proposedUpdate` is a `proposedConventions`/`proposedGlossary` addition, asserting zero `briefPath` writes (§5.5, §8c).
- **[minor] `renderBriefForPrompt` bloat brake is prose-only** → **Resolved (structural floor).** `renderBriefForPrompt` caps rendered conventions/glossary to top-N/top-M with a `+K more` note; a 100-entry array renders bounded (asserted) (§3.2 rule 4, §8a).

**Lens — part-or-all termination safety (would-not-ship → resolved)**
- **[major] misleading `goal-fully-met` on a strict subset / optional-only slice** → **Resolved.** Terminal reason split: `goal-fully-met` reserved for `target == all-required` AND all required passing; `target-slice-met` for any strict subset or any target with `required:false` ids, with a notify enumerating still-failing required criteria (§5.4 point 5, §8d).
- **[major] milestone stop-and-ask is brief-global, precedence with target-met unspecified** → **Resolved.** v2 pins option (a): ANY milestone-bearing brief always yields `machine-criteria-met-pending-human` regardless of target; **milestone outranks target-met**; documented consequence that open milestones gate all autonomous-to-goal; rate-limited to avoid park nag (§5.4 point 6, §8d, §9 Q7).
- **[major] empty-set guard necessary-but-not-sufficient; point-4 over-claim** → **Resolved.** Added the **zero-required-criterion refusal**: a non-empty target of only `required:false` ids refuses success (`target-has-no-required-criterion`); §5.4 point 4 now states the empty guard is necessary-but-not-sufficient and pairs it with required-coverage (§5.4 point 4, §8d).
- **[minor] unknown-id `throw` inconsistent with refuse-to-run discipline** → **Resolved.** Unknown id returns typed `reason:'invalid-target'` + notify + no run (no stack-unwind) (§5.4 point 3, §8d).
- **[minor] wide-slice unsatisfiable member masked as generic `cap-hit`** → **Resolved.** `cap-hit` with a constant failing-required set across the run flags a likely unsatisfiable/over-specified target in the notify (§5.4 work-bridge, §8d).

**Lens — intake-zero-questions over-claim + wiring**
- **[minor] missed intake consumers (`auto-intake.ts:77`)** → **Resolved by honest scoping.** Stated explicitly that the brief feeds only the 3 design/audit callsites; `auto-intake` is intentionally not brief-fed this epic (named deferred extension) (§4bis, §9 Q10).
- **[minor] thin/unconfirmed brief has no intake-feed degradation rule** → **Resolved.** Unconfirmed/thin brief may inject as advisory context but `renderBriefForPrompt` marks gap/unconfirmed fields `DRAFT/UNCONFIRMED`, so it degrades toward over-asking, never over-suppressing (§4.2a, §4bis, §8b).
- **[minor] "flag material drift" label conflates intake-feed with drift mechanism** → **Resolved.** Intake label is the directional "North star — build toward this:"; the drift flag is the separate deterministic `classifyDrift` step (§4bis, §5.2, §8b).

**Lens — non-technical friction + lean (would-not-ship → resolved)**
- **[major] jargon leak in the load-bearing success question** → **Resolved.** Ring 1 success question is plain-language ("How would YOU check it's working — what would you look at, click, or see?"); the agent's documented SKILL.md duty is to translate to a candidate `command` or route to `milestones`, with an unfilled placeholder an expected non-blocking cold-start state; "command"/"tests-green" dropped from owner-facing words (§4.1 Stage 2 Ring 1, §4.2, §9 Q2).
- **[major] "grown over time" can become a nag** → **Resolved.** Conventions/glossary growth bound to the same milestone-marker + rate-limit + batched-into-one-proposal throttle as the milestone `proposedUpdate` (§3.2 rule 3, §4.1 Ring 3, §4.3, §5.5, §6).
- **[minor] lean constraint has no structural floor** → **Resolved.** `renderBriefForPrompt` render cap (top-N/top-M + `+K more`) gives the lean constraint structural teeth at the one bloat point (§3.2 rule 4, §8a). Same fix as the growth-vs-INV-A render-cap finding.
- **[minor] intake prompt hard-codes "before asking Bashir"** → **Resolved.** Owner name parameterized/genericized in the intake-prompt edit so the generalization claim holds (§4bis, §5.2, §8b).
