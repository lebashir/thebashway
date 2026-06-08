// tools/orchestrator/config.ts
// The ONLY project-specific file in the orchestrator. A new project swaps this
// out and keeps everything else. See the spec's "Portability" section.
import { resolve } from "node:path";
import type { SurfaceConfig } from "./verify/types";
import type { ResolvedBinding } from "./binding";

/**
 * Run-mode budget: the maximum number of in-flight *build* bashas (heavy — each
 * runs a full `verify`, incl. a Next build) across ALL queue items + within-item
 * slices. Bounded by laptop resources (RAM under stacked Next builds), NOT cost
 * (subscription = unmetered). Read-only analysis fan-outs (e.g. the directed
 * audit's finders) are cheap and run up to the harness ceiling (~10), not this
 * cap. The autonomous run loop allocates this FIFO. See thebashway skill.
 */
export const MAX_CONCURRENT_BASHAS = 6;

/**
 * Branch pattern for orphan-branch cleanup assertions. Branches matching this
 * pattern that are not currently checked out anywhere are reported as orphans.
 * Override per-call via preflight({ branchPattern: ... }).
 */
export const DEFAULT_BRANCH_PATTERN = "tbw/*";

/**
 * Stage 2 capture-sweep binding. The sweep scans `scanGlobs` (minus `excludeGlobs`,
 * applied as a post-scan reject filter — Bun.Glob has no native ignore) for the
 * deliberate `(tbw)`-flagged marker only: the opt-in form of TODO / FIXME. Bare
 * TODO / FIXME are intentionally NOT swept (that would flood the queue and the
 * sweep would enqueue its own source's marker words). Each hit becomes a
 * @needs-intake / origin:auto item, deduped by fingerprint, capped at maxPerSweep.
 *
 * NOTE: this file is itself under scanGlobs, so it must never contain the literal
 * flagged-marker string — only the regex below (which does not self-match).
 */
export const SWEEP = {
  scanGlobs: ["tools/**/*.ts"],
  excludeGlobs: [
    "**/node_modules/**",
    "**/.next/**",
    "**/__tests__/**",
    "**/*.test.ts",
    "**/*.d.ts",
    "**/generated/**",
  ],
  // Group 1 captures the text after the marker. Per-line (no /g); the caller
  // iterates lines so it can record the line number in the item's goal.
  markerRegex: /\b(?:TODO|FIXME)\(tbw\)\s*:\s*(.*)$/,
  // Wrap-up-audit candidate files (produced by tools/jobs/wrap-up-extract.sh). The
  // sweep harvests ONLY bullets carrying a concrete engineering signal — most wrap-up
  // candidates are life/behavioral lessons (own pipeline) or regex artifacts. The
  // keyword filter is deliberately conservative; the @needs-intake gate + LLM intake
  // is the real triage. See decisions.md [tools] + the Stage 2 plan.
  wrapUpGlobs: ["inbox/*-wrap-up-candidates.md"],
  wrapUpSignal:
    /\b(?:bug|fix(?:es|ed)?|broke[n]?|regress(?:ion)?|flaky|crash(?:es|ed)?|race condition|deadlock|leak|null|undefined|off-by-one|edge case|refactor|dedup|test(?:s|ing)?|lint|type ?error|typecheck|migration|endpoint|\bAPI\b|perf(?:ormance)?|cache|throttle|timeout|stale|smoke|verify gate)\b/i,
  maxPerSweep: 10,
  // Soft warning threshold: when the un-triaged @needs-intake backlog exceeds this,
  // the sweep prints a heads-up so the queue can't silently grow unbounded.
  backlogWarnAt: 25,
};

/**
 * Directed-audit fan-out ceiling: the maximum number of sub-areas (finder bashas)
 * the IN door will dispatch for a single audit target. Read-only finders are cheap,
 * but unbounded fan-out (e.g. a huge monorepo root) would explode costs. The build
 * fan-out (MAX_CONCURRENT_BASHAS) is a separate, tighter cap for heavy build work.
 */
export const AUDIT_FANOUT_MAX = 10;

/**
 * The confidence floor (0-1) a confirmed audit finding must clear for the IN door to
 * shape it as build-ready (`@unclaimed`). Below it, the item is forced to
 * `@needs-intake` regardless of the shaper's chosen status — so an unsupervised auto
 * build is never kicked off by a borderline finding. Confidence is otherwise advisory;
 * the full build-ready gate is `freezeSafe && !openQuestion && shaper-chose-unclaimed
 * && confidence >= this`.
 */
export const AUDIT_BUILDREADY_MIN_CONFIDENCE = 0.8;

/**
 * The lower bar: a finding the adversarial verify pass returns must clear this
 * confidence to count as a CONFIRMED defect at all (below it, drop entirely — it is
 * not real enough to act on). Distinct from the build-ready floor above: a finding in
 * [confirm, buildReady) is real enough to QUEUE but only as `@needs-intake`.
 */
export const AUDIT_CONFIRM_MIN_CONFIDENCE = 0.7;

/**
 * Per-audit enqueue cap: the maximum number of shaped findings a single `audit` run
 * writes to the queue. Keeps `queue.md` from flooding (consistent with the sweep's
 * `maxPerSweep` and the per-basha self-enqueue budget); the finder fan-out cap bounds
 * bashas, not the count of findings they return. Over-cap findings are dropped lowest-
 * confidence-first with a reported "dropped K over cap" line.
 */
export const AUDIT_MAX_ENQUEUE = 12;

/**
 * Per-`design`-run task cap. A feature decomposed into more than this many tasks is
 * ABORTED ("too large; split it"), never truncated — unlike a dropped low-confidence
 * audit finding, a dropped design task is a half-built feature. Matches AUDIT_MAX_ENQUEUE.
 */
export const DESIGN_MAX_TASKS = 12;

/**
 * The deterministic irreversible / person-reaching deny-list for the feature-design IN
 * door. The OUT door's "park anything that reaches a real person or destroys unrecoverable
 * data" rail lives only as SKILL/decisions PROSE that the interactive driver honors — it
 * is NOT code in drain.ts. The design door removes that human driver, so it re-adds the
 * rail HERE, deterministically: `classifyIrreversible` (design.ts) forces any matching
 * task to @needs-intake regardless of freeze-authorization. The typed `design` command
 * authorizes new UI; it does NOT authorize reaching people or destroying data. Err toward
 * over-matching: a false @needs-intake costs one human glance; a false build-ready could
 * email people or drop data autonomously.
 */
export const DESIGN_IRREVERSIBLE = {
  // Territory globs that are inherently person-reaching / external-write. Matched by path-
  // prefix OVERLAP (a broad territory that *contains* one of these is caught too). DIRECTORY-
  // LEVEL and FAIL-SAFE by design: a task editing one of these with neutral wording ("wire the
  // dispatch loop") names no keyword in its text, and a hand-curated file list silently drifts
  // as new jobs land — so we deny the whole `tools/jobs/**` tree (scheduled automations: most
  // message a person or act on a schedule) and `tools/google/**` (Gmail/Calendar read+write).
  // A NEW job is thus person-reaching-by-DEFAULT (forced @needs-intake — the safe direction),
  // never fail-open. This is deliberately conservative: a benign job fix needs one human glance,
  // which is cheap; a false build-ready could message people or cancel events autonomously.
  // Defense in depth: also the LLM reachesPeople/destructive flags, the keyword net over text
  // AND territory paths, and the decompose-prompt instruction.
  territoryGlobs: ["tools/google/**", "tools/jobs/**"],
  // The keyword net: a task whose title/goal/done-when (or a territory path) contains any of
  // these parks. Tense + synonym variants included (send/email/message/notify/DM/ping/text/
  // nudge/remind/reach out/broadcast/blast/alert/mail/publish/tweet/post; delete/drop/truncate/
  // destroy/purge/wipe/erase/cancel/flush/clear all/reset db). Err toward over-matching (a false
  // @needs-intake costs one glance; a false build-ready could reach people or destroy data).
  keywords:
    /\b(?:send|sends|sending|sent|email|e-mail|emails|emailed|mail|message|messages|messaged|messaging|dm|dms|ping|pings|text|texts|texting|notify|notifies|notified|notifying|notification|nudge|nudges|nudging|remind|reminds|reminder|reminders|reach out|reaches out|sms|whatsapp|telegram|slack|broadcast|broadcasts|blast|blasts|alert|alerts|publish|published|tweet|tweets|post to|posts to|delete|deletes|deleting|deleted|drop|drops|dropping|dropped|truncate|truncates|truncated|destroy|destroys|destroying|destroyed|cancel|cancels|cancelling|canceling|cancelled|purge|purges|purged|wipe|wipes|wiped|erase|erases|erased|flush|flushes|remove all|removes all|removed all|clear all|reset the (?:db|database|table)|rm -rf)\b/i,
};

/**
 * OUT-door drain circuit breaker (sliding window). The loop appends exactly ONE
 * outcome boolean per FULLY-RESOLVED queue item (final pass/fail after the in-item
 * retry — never per attempt). It trips when `maxFailures` of the last `window`
 * item-outcomes failed, halting further claims. The per-item runaway guard
 * (`overBudget`) is a separate concern and never feeds this window.
 */
export const DRAIN_BREAKER = { maxFailures: 2, window: 3 } as const;

/**
 * Registry of well-known audit targets. Key = canonical name (lowercase); value =
 * an AuditPlan-shape object. The IN door's resolveTarget() looks here first before
 * falling back to the generic dir-split path.
 *
 * `surface` must match a key in SURFACES above.
 * `rootGlob` is the broad coverage glob for the whole target.
 * `subAreas` are the fan-out partitions for finder bashas (one basha per sub-area).
 */
export const AUDIT_TARGETS: Record<
  string,
  { surface: "organs" | "tools"; rootGlob: string; subAreas: string[] }
> = {
  money: {
    surface: "organs",
    rootGlob: "organs/src/sections/money/**",
    // Real partitions of the money module (no phantom dirs): the UI components,
    // the two big logic files split out (read ~32KB, actions ~40KB), the
    // calc/forecast cluster, and the schema/wiring files. Test files are not
    // listed (audits target source, not tests).
    subAreas: [
      "organs/src/sections/money/components/**",
      "organs/src/sections/money/read.ts",
      "organs/src/sections/money/actions.ts",
      "organs/src/sections/money/{forecast,parse,currency,period}.ts",
      "organs/src/sections/money/{schema,config,index}.ts",
    ],
  },
};

export const SURFACES: Record<string, SurfaceConfig> = {
  organs: {
    dir: "organs",
    role:
      "A secondary, deployed web-hub VIEW (lifeofbash.vercel.app). NOT the default home " +
      "for new features. Choose this surface ONLY when the feature is intrinsically a hub " +
      "UI view the user explicitly wants online — never as a fallback for work that has " +
      "no other home.",
    chain: [
      { name: "tsc", cmd: ["pnpm", "exec", "tsc", "--noEmit"] },
      { name: "lint", cmd: ["pnpm", "lint"] },
      { name: "test", cmd: ["pnpm", "test"] },
      // `pnpm build` runs the `prebuild` lifecycle (snapshot regen); `next build`
      // does NOT. Using `pnpm build` here is the fix for failure #3.
      { name: "build", cmd: ["pnpm", "build"] },
    ],
    derived: [
      "organs/src/generated/home-snapshot.json",
      "organs/src/generated/people-snapshot.json",
    ],
    regen: { name: "gen:home", cmd: ["pnpm", "gen:home"] },
    smoke: {
      cmd: ["pnpm", "exec", "tsx", "scripts/smoke-prod.ts"],
      portEnv: "SMOKE_PORT",
      needsBuild: true,
    },
    needsRealInstall: true,
    stageNotDeploy: true,
  },
  tools: {
    dir: "tools",
    role:
      "The substrate's executable layer — the DEFAULT home for new capabilities: " +
      "automations, MCP tools, jobs, scripts, the orchestrator. Most new features live " +
      "here. Ambiguous features default here, never to organs.",
    chain: [
      { name: "test", cmd: ["bun", "test"] },
      { name: "validate", cmd: ["bun", "run", "validate"] },
    ],
    derived: [],
    regen: null,
    smoke: null,
    // Tabby machine: bun fails TLS to external HTTPS without this. See memory
    // [[bun-tls-tabby-proxy]].
    env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
  },
};

// ---------------------------------------------------------------------------
// Binding injection (portable engine)
//
// SURFACES, AUDIT_TARGETS, SWEEP, and DESIGN_IRREVERSIBLE above are the
// project-specific binding. They default to lifeofbash's values (kept here so the
// engine's own tests + a lifeofbash run behave identically). A DIFFERENT project's
// CLI calls setBinding(loadedBinding) once at startup to override them IN PLACE.
// Consumers `import { SURFACES } from "./config"` and read these objects at
// call-time, so an in-place swap reaches every reader without threading a binding
// parameter through the whole engine. resetBinding() restores the defaults (tests).
// ---------------------------------------------------------------------------

const _DEFAULTS = {
  surfaces: { ...SURFACES },
  auditTargets: { ...AUDIT_TARGETS },
  sweep: { ...SWEEP },
  rails: { territoryGlobs: DESIGN_IRREVERSIBLE.territoryGlobs, keywords: DESIGN_IRREVERSIBLE.keywords },
};

function _replaceRecord<T>(target: Record<string, T>, src: Record<string, T>): void {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, src);
}

let _defaultSurface = "tools";
let _repoRoot = resolve(import.meta.dir, "..", "..");
let _briefPath = ".thebashway/brief.ts";
let _briefSensitivity: "off" | "low" | "medium" | "high" = "medium";

/** The binding's defaultSurface — where ambiguous work and unknown paths land. */
export function getDefaultSurface(): string {
  return _defaultSurface;
}

/** The target repo's root (binding.repoRoot). Defaults to this package's root for tests. */
export function getRepoRoot(): string {
  return _repoRoot;
}

/** The per-project design brief path (binding.learning.brief). Defaults to `.thebashway/brief.ts`. */
export function getBriefPath(): string {
  return _briefPath;
}

/** The drift-warning sensitivity (binding.rails.briefDriftSensitivity). Defaults to 'medium'. */
export function getBriefSensitivity(): "off" | "low" | "medium" | "high" {
  return _briefSensitivity;
}

/** Override the project-specific binding values in place. Called once by the CLI at startup. */
export function setBinding(b: ResolvedBinding): void {
  _defaultSurface = b.defaultSurface;
  _repoRoot = b.repoRoot;
  // belt-and-suspenders coalescing so a raw binding injected directly in a test still behaves.
  _briefPath = b.learning.brief ?? ".thebashway/brief.ts";
  _briefSensitivity = b.rails.briefDriftSensitivity ?? "medium";
  _replaceRecord(SURFACES, b.surfaces as unknown as Record<string, SurfaceConfig>);
  _replaceRecord(AUDIT_TARGETS, (b.auditTargets ?? {}) as typeof AUDIT_TARGETS);
  Object.assign(SWEEP, b.sweep ?? _DEFAULTS.sweep);
  DESIGN_IRREVERSIBLE.territoryGlobs = b.rails.territoryGlobs;
  DESIGN_IRREVERSIBLE.keywords = b.rails.keywords;
}

/** Restore the built-in lifeofbash defaults (used by tests to avoid cross-contamination). */
export function resetBinding(): void {
  _defaultSurface = "tools";
  _repoRoot = resolve(import.meta.dir, "..", "..");
  _briefPath = ".thebashway/brief.ts";
  _briefSensitivity = "medium";
  _replaceRecord(SURFACES, _DEFAULTS.surfaces);
  _replaceRecord(AUDIT_TARGETS, _DEFAULTS.auditTargets);
  Object.assign(SWEEP, _DEFAULTS.sweep);
  DESIGN_IRREVERSIBLE.territoryGlobs = _DEFAULTS.rails.territoryGlobs;
  DESIGN_IRREVERSIBLE.keywords = _DEFAULTS.rails.keywords;
}
