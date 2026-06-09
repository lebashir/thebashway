// tools/orchestrator/drain.ts
// The OUT-door drain loop, codified: one command runs
//   preflight → (per item) claim → spawn(build basha) → re-verify → integrate → digest →
//   breaker → (once, at the end) land → Telegram
// for each build-ready queue item. By DEFAULT the run LANDS when it finishes: it merges
// the green integration branch into main and pushes — and pushing main auto-deploys
// organs via Vercel (the integration branch is already smoke-verified, so the land is
// post-smoke and rails-compliant). Land is skipped on a breaker trip, an abort, or no
// successful item, and `--no-land` opts out (stop at the green integration branch). The
// PER-UNIT loop never pushes and never targets main; only the final land step touches it.
//
// The orchestration core (`drain`) is layer-clean and fully unit-testable: every
// side-effecting stage is an injected `DrainDeps` seam, the real queue mutations go
// through the existing flock-guarded queue-ops, and the circuit breaker is the
// existing pure `shouldTrip`. The real seam implementations live in
// `defaultDrainDeps` (wired by cli.ts), which the unit tests never execute.
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { rm, symlink } from "node:fs/promises";
import type { QueueItem } from "./queue";
import type { ProjectBinding } from "../binding";
import { claimNextN, markDone, markBlocked, previewClaimable } from "./queue-ops";
import { shouldTrip } from "./breaker";
import { type DigestRecord, summaryLine } from "./digest";
import { DRAIN_BREAKER, MAX_CONCURRENT_BASHAS, SURFACES } from "./config";
import { buildBashaPromptFromDisk } from "./basha-prompt";
import { isUiTerritory } from "./design-bar";
import { runClaude, parseMarker } from "./headless";
import { spawnWorktree } from "./worktree-seed";
import { assertClean } from "./cleanup";
import { recheckManifest } from "./manifest-check";
import { appendLesson } from "./lessons";
import { appendDigest } from "./digest";
import { bunRun } from "./verify/run";
import type { VerifyManifest } from "./verify/types";
import type { DesignBrief } from "./brief";
import { loadBrief as realLoadBrief, type LoadBriefResult } from "./load-brief";
import { evaluateCheckSpec } from "./brief-eval";
import { goalMet } from "./breaker";

// ---------------------------------------------------------------------------
// Seam contracts
// ---------------------------------------------------------------------------

export interface BashaOutcome {
  ok: boolean;
  branch: string;
  reason?: string;
  /** Loop B (capture-as-you-go): a one-line `[tag] rule` the basha self-distilled (parsed from a
   * `LESSON:` marker in its output) when a gate caught a reusable pitfall — on a DONE (it
   * overcame it) or a BLOCKED (it authored the failure). Routed verbatim through `appendLessonFn`
   * so the next basha on this surface avoids it. Optional — omitted leaves behavior unchanged. */
  lesson?: string;
}
export interface VerifyOutcome {
  ok: boolean;
  manifestHash: string;
  reason?: string;
}
export interface IntegrateOutcome {
  ok: boolean;
  reason?: string;
  /** A merge/verify conflict between declared-disjoint units (re-intake signal). */
  misSlice?: boolean;
}

export interface DrainDeps {
  /** Make a ready-to-build worktree for the claimed item on its unit branch. */
  setupWorktree(item: QueueItem, branch: string): Promise<{ worktree: string }>;
  /** Run the headless build basha; resolves to ok + the branch it built. */
  runBasha(item: QueueItem, ctx: { worktree: string; branch: string }): Promise<BashaOutcome>;
  /** Re-verify the unit branch in isolation (+ tamper recompute); returns the manifest
   * hash. Runs against the WORKTREE (where the basha committed the unit's work) — the
   * primary checkout's HEAD does not contain it. */
  verifyUnit(item: QueueItem, branch: string, worktree: string): Promise<VerifyOutcome>;
  /** Merge the unit branch onto the integration branch and integration-re-verify
   * with the union of territories merged so far. LOCAL merge — never pushes. */
  integrateUnit(
    item: QueueItem,
    branch: string,
    integrationBranch: string,
    unionTerritory: string[],
  ): Promise<IntegrateOutcome>;
  /** Tear down the unit worktree + delete the unit branch. */
  teardownWorktree(worktree: string, branch: string): Promise<void>;
  /** Leave-no-trace assertion for the unit's own branch (NOT the integration branch). */
  assertCleanFn(unitBranch: string): Promise<{ ok: boolean; detail?: string }>;
  /** Telegram (or any) notifier; no-op default keeps the core layer-clean. */
  notify(text: string): Promise<boolean>;
  /** Land the run when done: merge the integration branch into the land branch (main)
   * and push — pushing main auto-deploys organs via Vercel. The integration branch is
   * already smoke-verified by the loop, so this is post-smoke (rails-compliant). Returns
   * ok, or a reason (e.g. an autonomous push blocked by the classifier) without throwing. */
  landFn(integrationBranch: string, landBranch: string): Promise<{ ok: boolean; reason?: string }>;
  /** Run-once session prep. */
  preflightFn(): Promise<{ ok: boolean; detail?: string }>;
  /** Append a Loop B lesson (mis-slice). */
  appendLessonFn(line: string): Promise<void>;
  /** Append a digest record to the run log. */
  appendDigestFn(rec: DigestRecord): Promise<void>;
  /**
   * OPTIONAL in-drain early-stop oracle (spec 5.4). Undefined => today's behavior (the drain
   * never early-stops on a brief goal). When `stopWhenBriefMet` is set, the loop calls this
   * after each SUCCESSFUL integrate to ask "is the target met now?" — if true the loop breaks
   * before the next claim (gating NEW CLAIMS only; it never bypasses the breaker/land/safety
   * gates). `target` is the slice runToGoal is driving toward; omitted => the real impl uses
   * ALL required ids (back-compat). The reducer + evaluator it composes are tested separately;
   * this seam is never executed in unit tests.
   */
  briefSatisfied?(brief: DesignBrief, target?: Set<string>): Promise<boolean>;
  /**
   * OPTIONAL brief loader (spec 5.4). Used ONLY when `stopWhenBriefMet` is set, to load the
   * brief ONCE per drain so `briefSatisfied` has a `brief` in scope. Undefined (the default)
   * leaves every existing fake untouched — the early-stop seam is simply inert. Defaults to the
   * real `loadBrief` in `defaultDrainDeps`.
   */
  loadBrief?(briefPath: string): Promise<LoadBriefResult>;
}

export interface DrainOptions {
  surface: string;
  queuePath: string;
  repoRoot: string;
  n?: number;
  integrationBranch?: string;
  breaker?: { maxFailures: number; window: number };
  retryOnce?: boolean;
  /** Default true (interactive): build origin:auto items too. False = headless guard. */
  autoBuild?: boolean;
  /** Default true: when the run succeeds, merge the integration branch into `landBranch`
   * and push (→ auto-deploy). `--no-land` stages-only (stop at the green branch). */
  land?: boolean;
  /** The branch the land step merges into and pushes. Default "main". */
  landBranch?: string;
  /** Feature-isolation allow-list: when set, the drain claims ONLY items whose title is in
   * this list (the design door passes its own enqueued task titles so a pre-existing queue
   * item is neither built nor folded into the run's landing decision). Undefined = claim any
   * claim-able item on the surface (the normal drain). */
  claimTitles?: string[];
  session?: string;
  dryRun?: boolean;
  noPreflight?: boolean;
  /**
   * OPT-IN in-drain EARLY-STOP (spec 5.4). When true (and `deps.briefSatisfied` is wired), the
   * loop stops claiming NEW items as soon as the brief target is met after a successful integrate
   * — a single-drain early-stop, NOT a loop (looping is runToGoal's job). It gates NEW CLAIMS
   * only: it never bypasses the breaker, `unsafeIntegrationBranch`, feature-atomic landing, or
   * the default-on land (what is green still lands via `landFn`). The feature-isolated design-door
   * drain (`claimTitles` set => `allowTitles`) IGNORES this flag (it is feature-atomic and must
   * not self-terminate on a global goal). Default false => today's behavior.
   */
  stopWhenBriefMet?: boolean;
  /** The success-criterion id slice the early-stop drives toward (passed through to
   * `briefSatisfied`'s `target`). Omitted => the real `briefSatisfied` uses all required ids. */
  targetCriteria?: string[];
  /** Path to the brief.ts module — loaded ONCE via `deps.loadBrief` only when `stopWhenBriefMet`
   * is set. Unused otherwise (existing drains never load a brief). */
  briefPath?: string;
}

export interface DrainReport {
  ranPreflight: boolean;
  claimed: string[];
  succeeded: string[];
  blocked: { item: string; reason: string }[];
  /** How many origin:auto (machine-captured) items were built — the observable gate. */
  autoBuiltCount: number;
  breakerTripped: boolean;
  integrationBranch: string;
  /** True once the integration branch was merged to the land branch and pushed (deployed). */
  landed?: boolean;
  /** Human-readable land outcome (pushed/deploy, staged-only, or the failure reason). */
  landResult?: string;
  digests: DigestRecord[];
  summaryLines: string[];
  /** Set (and the run is a no-op) when the run aborts before processing. */
  aborted?: string;
  /** Set true when the in-drain early-stop (spec 5.4 `stopWhenBriefMet`) fired: the brief target
   * was met after a successful integrate, so the loop stopped claiming new items. */
  goalMet?: boolean;
}

function branchSlug(title: string): string {
  return `tbw/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`;
}

/** main / non-tbw integration branches are rejected: the loop must never push to or
 * merge onto a deploy-tracked branch. */
function unsafeIntegrationBranch(b: string): string | null {
  if (b === "main" || b === "master") return `integration branch must never be "${b}"`;
  if (!b.startsWith("tbw/")) return `integration branch must be tbw/-prefixed, got "${b}"`;
  return null;
}

// ---------------------------------------------------------------------------
// Binding-derived OUT-door paths (the portability seam)
// ---------------------------------------------------------------------------

export interface DrainPaths {
  /** The surface's dir (checkout-relative) — where its `verify` package script + manifest live. */
  surfaceDir: string;
  /** The verify manifest path (checkout-relative): binding.paths.manifest or the .thebashway default. */
  manifestRel: string;
  /** node_modules symlink sources to mirror from the primary checkout into a non-real-install worktree. */
  nodeModulesLinks: string[];
}

/**
 * Derive the OUT-door loop's checkout-relative paths from the BINDING — never hardcoded. This is the
 * fix for the loop's old lifeofbash coupling (a literal "tools" + "tools/orchestrator/.verify-manifest.json"):
 * the verify subprocess runs in `surfaceDir` (where the repo's `verify` package script + manifest
 * resolve), the orchestrator reads the manifest at `manifestRel`, and a non-real-install worktree
 * mirrors `nodeModulesLinks`. A root surface (dir ".") yields just the root link — no redundant
 * "./node_modules"; a subdir surface also mirrors its own.
 */
export function drainPaths(binding: Pick<ProjectBinding, "surfaces" | "paths">, surface: string): DrainPaths {
  const surfaceDir = binding.surfaces[surface]?.dir ?? ".";
  const manifestRel = binding.paths?.manifest ?? ".thebashway/.verify-manifest.json";
  const nodeModulesLinks = surfaceDir === "." ? ["node_modules"] : ["node_modules", `${surfaceDir}/node_modules`];
  return { surfaceDir, manifestRel, nodeModulesLinks };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export async function drain(opts: DrainOptions, deps: DrainDeps): Promise<DrainReport> {
  const n = opts.n ?? MAX_CONCURRENT_BASHAS;
  const surface = opts.surface;
  const integrationBranch = opts.integrationBranch ?? `tbw/integration-${surface}`;
  const breaker = opts.breaker ?? DRAIN_BREAKER;
  const retryOnce = opts.retryOnce ?? true;
  const autoBuild = opts.autoBuild ?? true;
  const land = opts.land ?? true;
  const landBranch = opts.landBranch ?? "main";
  const session = opts.session ?? "drain";
  // Only claim items belonging to this surface — the drain runs one surface's
  // build/verify config (a mixed-surface queue must not cross-build).
  const surfaceDir = SURFACES[surface]?.dir ?? surface;
  // Feature-isolation allow-list (the design door passes its own task titles).
  const allowTitles = opts.claimTitles ? new Set(opts.claimTitles) : undefined;

  const report: DrainReport = {
    ranPreflight: false,
    claimed: [],
    succeeded: [],
    blocked: [],
    autoBuiltCount: 0,
    breakerTripped: false,
    integrationBranch,
    digests: [],
    summaryLines: [],
  };

  // Safety gate: never integrate onto main / a non-tbw branch (no-deploy enforced).
  const unsafe = unsafeIntegrationBranch(integrationBranch);
  if (unsafe) {
    report.aborted = unsafe;
    return report;
  }

  // Dry-run: report what WOULD be claimed, mutate nothing.
  if (opts.dryRun) {
    const preview = await previewClaimable(n, opts.queuePath, { excludeAuto: !autoBuild, surfaceDir, allowTitles });
    report.claimed = preview.map((i) => i.title);
    report.autoBuiltCount = preview.filter((i) => i.origin === "auto").length;
    return report;
  }

  // Preflight once.
  if (!opts.noPreflight) {
    const pf = await deps.preflightFn();
    report.ranPreflight = true;
    if (!pf.ok) {
      report.aborted = `preflight failed${pf.detail ? `: ${pf.detail}` : ""}`;
      return report;
    }
  }

  const recent: boolean[] = [];
  const mergedTerritories: string[] = [];

  // In-drain EARLY-STOP seam (spec 5.4). Honored ONLY when stopWhenBriefMet is set AND this is
  // NOT the feature-isolated design-door drain (allowTitles set => feature-atomic; it must never
  // self-terminate on a global goal). Load the brief ONCE here, guarded so existing fakes with no
  // loadBrief dep are untouched.
  const earlyStopEnabled = !!opts.stopWhenBriefMet && allowTitles === undefined;
  let earlyStopBrief: DesignBrief | null = null;
  if (earlyStopEnabled && deps.loadBrief && opts.briefPath) {
    const loaded = await deps.loadBrief(opts.briefPath);
    earlyStopBrief = loaded.status === "ok" ? loaded.brief : null;
  }
  const earlyStopTarget = opts.targetCriteria ? new Set(opts.targetCriteria) : undefined;

  // Claim ONE item at a time: a breaker trip then leaves nothing stuck @claimed,
  // and each claim sees the freshest queue (serial integration).
  while (report.claimed.length < n) {
    const [item] = await claimNextN(1, session, (it) => branchSlug(it.title), opts.queuePath, {
      excludeAuto: !autoBuild,
      surfaceDir,
      allowTitles,
    });
    if (!item) break; // nothing claim-able remains

    report.claimed.push(item.title);
    if (item.origin === "auto") report.autoBuiltCount++;

    const unitBranch = item.claim?.branch ?? branchSlug(item.title);
    const rec: DigestRecord = {
      item: item.title,
      manifestHash: "-",
      reviewVerdict: "-",
      deployResult: "-",
      anomalies: [],
      questionsAsked: 0,
    };
    let outcome = false;

    const { worktree } = await deps.setupWorktree(item, unitBranch);

    // Build (one retry on a transient failure).
    let basha = await deps.runBasha(item, { worktree, branch: unitBranch });
    if (!basha.ok && retryOnce) {
      basha = await deps.runBasha(item, { worktree, branch: unitBranch });
    }

    // Loop B capture (basha-emitted): a basha may self-distill a reusable pitfall as a
    // `LESSON: [tag] rule` line — on a DONE (capture-as-you-go) or a BLOCKED. Route it forward
    // verbatim through appendLessonFn (which parses `[tag] rule`; dedup collapses repeats). This
    // is the literal "the failing basha emits" path; the gate-detected failures below synthesize.
    if (basha.lesson) await deps.appendLessonFn(basha.lesson);

    if (!basha.ok) {
      const reason = basha.reason ?? "build failed";
      await markBlocked(item.title, reason, opts.queuePath);
      report.blocked.push({ item: item.title, reason });
      rec.deployResult = `blocked: ${reason}`;
      rec.anomalies.push("build failed");
      // No synthesized lesson on a plain build-fail: it is often a transient timeout (after the
      // one retry above), and the basha's own LESSON:/BLOCKED text already carries the signal.
    } else {
      const v = await deps.verifyUnit(item, unitBranch, worktree);
      rec.manifestHash = v.manifestHash || "-";
      if (!v.ok) {
        const reason = v.reason ?? "verify failed";
        await markBlocked(item.title, reason, opts.queuePath);
        report.blocked.push({ item: item.title, reason });
        rec.reviewVerdict = "verify-fail";
        rec.deployResult = `blocked: ${reason}`;
        rec.anomalies.push("verify failed");
        // Loop B (synthesized): the basha returned DONE but drain's re-verify disagreed. Tag with
        // the SURFACE so the lesson actually feeds forward (basha prompts inject lessons by
        // buildAreas:[surface]; a non-surface tag would never inject).
        await deps.appendLessonFn(
          `[${surface}] "${item.title}" passed the build basha's self-check but failed drain's re-verify (${reason}) — the basha's verify run and the gate diverged; assert the failing case before re-claiming.`,
        );
      } else {
        rec.reviewVerdict = "verify-pass";
        const unionTerritory = [...mergedTerritories, ...item.territory];
        const integ = await deps.integrateUnit(item, unitBranch, integrationBranch, unionTerritory);
        if (!integ.ok) {
          const reason = integ.reason ?? "integration re-verify failed";
          await markBlocked(item.title, reason, opts.queuePath);
          report.blocked.push({ item: item.title, reason });
          rec.deployResult = `blocked: ${reason}`;
          rec.anomalies.push(integ.misSlice ? "mis-sliced" : "integration failed");
          // Loop B (synthesized): tag with the SURFACE (not [integration]) so it feeds forward.
          if (integ.misSlice) {
            await deps.appendLessonFn(
              `[${surface}] mis-sliced pair — re-intake: "${item.title}" conflicts on the integration branch with an already-merged unit (declared-disjoint territories overlapped at merge).`,
            );
          } else {
            await deps.appendLessonFn(
              `[${surface}] "${item.title}" verified alone but the integration re-verify failed (${reason}) — a cross-unit interaction the unit verify missed.`,
            );
          }
        } else {
          await markDone(item.title, opts.queuePath);
          mergedTerritories.push(...item.territory);
          report.succeeded.push(item.title);
          rec.deployResult = "integrated (not deployed)";
          outcome = true;
        }
      }
    }

    // Leave-no-trace for the UNIT (the integration branch is the run's output).
    await deps.teardownWorktree(worktree, unitBranch);
    const clean = await deps.assertCleanFn(unitBranch);
    if (!clean.ok) rec.anomalies.push(`leave-no-trace: ${clean.detail ?? "unclean"}`);

    report.digests.push(rec);
    report.summaryLines.push(summaryLine(rec));
    await deps.appendDigestFn(rec);

    recent.push(outcome);
    if (shouldTrip(recent, breaker.maxFailures, breaker.window)) {
      report.breakerTripped = true;
      break;
    }

    // In-drain EARLY-STOP (spec 5.4): after a SUCCESSFUL integrate, if the brief target is met,
    // stop claiming NEW items. This NEVER bypasses the breaker (checked above), the land step
    // (runs below on succeeded>0), or any safety gate — it only short-circuits the claim loop.
    // Inert unless stopWhenBriefMet + a wired briefSatisfied + a loaded brief; ignored for the
    // feature-isolated design-door drain (allowTitles set).
    if (outcome && earlyStopEnabled && earlyStopBrief && deps.briefSatisfied) {
      if (await deps.briefSatisfied(earlyStopBrief, earlyStopTarget)) {
        report.goalMet = true;
        break;
      }
    }
  }

  // Land the run (default ON): merge the integration branch into the land branch and
  // push (→ auto-deploy organs via Vercel). Skipped on breaker trip, abort, no success,
  // or --no-land. The integration branch is already smoke-verified (post-smoke land).
  const doneN = report.succeeded.length;
  if (land && doneN > 0 && !report.breakerTripped && !report.aborted) {
    const res = await deps.landFn(integrationBranch, landBranch);
    report.landed = res.ok;
    report.landResult = res.ok
      ? `merged ${integrationBranch} → ${landBranch} + pushed (auto-deploy)`
      : `LAND FAILED (work is safe at ${integrationBranch}): ${res.reason ?? "unknown"}`;
  } else if (doneN > 0) {
    const why = !land ? " — --no-land" : report.breakerTripped ? " — breaker tripped" : "";
    report.landResult = `staged at ${integrationBranch} (land skipped${why})`;
  }

  // Telegram digest.
  const blockedN = report.blocked.length;
  const autoNote = report.autoBuiltCount ? ` (${report.autoBuiltCount} origin:auto)` : "";
  const breakerNote = report.breakerTripped ? " [BREAKER TRIPPED — halted]" : "";
  const landNote = report.landed
    ? `deployed (pushed to ${landBranch})`
    : doneN > 0
      ? (report.landResult ?? `${integrationBranch} green`)
      : `${integrationBranch} unchanged`;
  const msg = `drain: ${surface} — ${doneN} done, ${blockedN} blocked${autoNote}; ${landNote}${breakerNote}`;
  await deps.notify(msg);
  report.summaryLines.unshift(msg);

  return report;
}

// ---------------------------------------------------------------------------
// Default (real) deps — wired by cli.ts; NOT executed in unit tests.
// ---------------------------------------------------------------------------

const WORKTREE_ROOT = join(homedir(), ".claude", "worktrees");

/**
 * The real DrainDeps. `notify` is supplied by the caller (cli.ts injects the real
 * notifyTelegram from ../jobs so drain.ts itself stays free of the cross-layer
 * import). Everything else wires the existing orchestrator primitives.
 *
 * NOTE: the default git/worktree plumbing here (worktree-located verify, the node_modules
 * symlink, manifest sharing, integration-branch restore, the land step) reads all of its
 * checkout-relative locations from the binding via `drainPaths` (surfaceDir / manifestRel /
 * nodeModulesLinks) — no hardcoded "tools". It was exercised live and green on BOTH lifeofbash
 * surfaces 2026-06-05 — two single-item
 * drains (an organs money fix + a tools ingest fix), each built by a headless basha,
 * verified, integrated, and landed to main + deployed. Still only lightly proven (two
 * runs); expect more edge cases at higher volume. The injected-seam core (`drain`) is
 * fully unit-tested.
 */
export function defaultDrainDeps(cfg: {
  surface: string;
  repoRoot: string;
  baseRef: string; // the run's base (pre-merge HEAD) for per-unit verify
  notify: (text: string) => Promise<boolean>;
  seedPaths: string[];
  runLogPath: string;
  lessonsPath: string;
  /** Binding-derived checkout-relative paths (surfaceDir / manifestRel / nodeModulesLinks) — see
   *  drainPaths(). Replaces the old hardcoded "tools" + "tools/orchestrator/.verify-manifest.json"
   *  so the loop runs on ANY repo, not just lifeofbash's layout. */
  paths: DrainPaths;
}): DrainDeps {
  const wtPath = (branch: string) => join(WORKTREE_ROOT, branch.replace(/[^a-zA-Z0-9]+/g, "-"));
  // The primary checkout's branch at run start — restored after each integrate so a
  // drain run never leaves the working tree parked on the integration branch.
  let originalRef: string | null = null;

  const verifyArgs = (baseRef: string, territory: string[]): string[] => [
    "bun",
    "run",
    "verify",
    "--surface",
    cfg.surface,
    "--base",
    baseRef,
    "--json",
    ...territory.flatMap((t) => ["--territory", t]),
  ];

  return {
    async setupWorktree(_item, branch) {
      const workPath = wtPath(branch);
      await spawnWorktree({
        workPath,
        repoRoot: cfg.repoRoot,
        seedPaths: cfg.seedPaths,
        branch,
        // A surface flagged needsRealInstall (e.g. Turbopack) gets a real install;
        // others symlink node_modules from the primary checkout (below).
        install: !!SURFACES[cfg.surface]?.needsRealInstall,
      });
      // A non-real-install surface (bun/pnpm-managed, no Turbopack) is NOT installed in the
      // worktree, so symlink node_modules from the primary checkout — without it the gate chain
      // can't resolve deps. The links are binding-derived (drainPaths): the repo root + the
      // surface's own dir, never a hardcoded "tools/node_modules". A real-install surface (e.g.
      // Turbopack, which rejects a symlinked node_modules) got its real install above.
      if (!SURFACES[cfg.surface]?.needsRealInstall) {
        for (const rel of cfg.paths.nodeModulesLinks) {
          const target = resolve(cfg.repoRoot, rel);
          const link = resolve(workPath, rel);
          if (existsSync(target) && !existsSync(link)) {
            await symlink(target, link).catch(() => {});
          }
        }
      }
      return { worktree: workPath };
    },

    async runBasha(item, ctx) {
      const taskBody = [
        `Build this queue item end to end on the current branch (${ctx.branch}).`,
        `TITLE: ${item.title}`,
        `GOAL: ${item.goal}`,
        `TERRITORY (only touch these globs): ${item.territory.join(", ")}`,
        `DONE-WHEN: ${item.doneWhen}`,
        ``,
        `Rules: write the test first (TDD), then the implementation. Stay strictly`,
        `inside TERRITORY. Run \`bun run verify --surface ${cfg.surface} --base ${cfg.baseRef} ` +
          item.territory.map((t) => `--territory ${t}`).join(" ") +
          `\` and make it green. Commit on this branch with an explicit path list (never git add -A).`,
        `Do NOT deploy, do NOT push, do NOT touch anything outside TERRITORY.`,
        `End your output with exactly one line: "DONE: <one-line summary>" on success,`,
        `or "BLOCKED: <reason>" if you cannot complete it.`,
        `If a gate (typecheck/test/lint) caught a non-obvious mistake you had to fix — or you are`,
        `blocked by one — ALSO emit one extra final line: "LESSON: [${cfg.surface}] <one-line rule>"`,
        `so the next basha on this surface avoids it.`,
      ].join("\n");
      const prompt = await buildBashaPromptFromDisk({
        repoRoot: cfg.repoRoot,
        lessonsPath: cfg.lessonsPath,
        taskBody,
        buildAreas: [cfg.surface],
      });
      // UI-bearing items get the stronger model (the designing basha): design quality is won by
      // capability, so don't build UI with the fast model. A file-extension/path heuristic, not a
      // surface-role gate. Logic work stays on the fast model.
      const model = isUiTerritory(item.territory) ? "opus" : "sonnet";
      const res = await runClaude({
        prompt,
        cwd: ctx.worktree,
        model,
        skipPermissions: true,
      });
      // Loop B: parse an optional self-distilled `LESSON: [tag] rule` line (may be present on a
      // DONE or a BLOCKED); the core routes it through appendLessonFn.
      const lesson = parseMarker(res.stdout, "LESSON") ?? undefined;
      if (!res.ok) return { ok: false, branch: ctx.branch, reason: res.timedOut ? "basha timed out" : "basha exited non-zero", lesson };
      const done = parseMarker(res.stdout, "DONE");
      if (done !== null) return { ok: true, branch: ctx.branch, lesson };
      const blocked = parseMarker(res.stdout, "BLOCKED");
      return { ok: false, branch: ctx.branch, reason: blocked ?? "no DONE/BLOCKED marker", lesson };
    },

    async verifyUnit(item, _branch, worktree) {
      // Run verify INSIDE the worktree's SURFACE dir (binding-derived, not a hardcoded "tools"):
      // the basha committed the unit's work on the worktree's branch, and `bun run verify` in the
      // surface dir resolves the repo's own `verify` script + loads its binding (repoRoot →
      // worktree), so its HEAD is the unit tip (the primary checkout's HEAD does NOT contain the
      // unit's work). Read the manifest the run wrote in the worktree (binding-derived path), then
      // tamper-recheck from the primary checkout (the head SHA is a shared git object).
      const worktreeSurface = resolve(worktree, cfg.paths.surfaceDir);
      const r = await bunRun(verifyArgs(cfg.baseRef, item.territory), { cwd: worktreeSurface });
      if (r.code !== 0) return { ok: false, manifestHash: "-", reason: `verify exit ${r.code}` };
      const wtManifest = resolve(worktree, cfg.paths.manifestRel);
      let manifestHash = "-";
      try {
        const m = JSON.parse(await Bun.file(wtManifest).text()) as VerifyManifest;
        manifestHash = m.diffSha256;
      } catch {
        return { ok: false, manifestHash: "-", reason: "manifest unreadable" };
      }
      const check = await recheckManifest(wtManifest, cfg.repoRoot);
      if (!check.ok) return { ok: false, manifestHash, reason: check.reason ?? "manifest tampered" };
      return { ok: true, manifestHash };
    },

    async integrateUnit(_item, branch, integrationBranch, unionTerritory) {
      // LOCAL merge only — never pushes. Capture the starting branch so the run never
      // leaves the working tree parked on the integration branch.
      if (originalRef === null) {
        const cur = await bunRun(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: cfg.repoRoot });
        originalRef = cur.code === 0 && cur.stdout.trim() ? cur.stdout.trim() : cfg.baseRef;
      }
      const restore = async () => {
        if (originalRef) await bunRun(["git", "checkout", originalRef], { cwd: cfg.repoRoot });
      };
      const ensure = await bunRun(["git", "rev-parse", "--verify", integrationBranch], { cwd: cfg.repoRoot });
      if (ensure.code !== 0) {
        const created = await bunRun(["git", "branch", integrationBranch, cfg.baseRef], { cwd: cfg.repoRoot });
        if (created.code !== 0) return { ok: false, reason: `cannot create ${integrationBranch}` };
      }
      const co = await bunRun(["git", "checkout", integrationBranch], { cwd: cfg.repoRoot });
      if (co.code !== 0) return { ok: false, reason: `cannot checkout ${integrationBranch}` };
      const merge = await bunRun(["git", "merge", "--no-ff", "--no-edit", branch], { cwd: cfg.repoRoot });
      if (merge.code !== 0) {
        await bunRun(["git", "merge", "--abort"], { cwd: cfg.repoRoot });
        await restore();
        return { ok: false, reason: "merge conflict", misSlice: true };
      }
      // On the integration branch now (merged tree) — integration re-verify against the
      // union territory, then restore the original branch regardless of the result.
      const r = await bunRun(verifyArgs(cfg.baseRef, unionTerritory), { cwd: resolve(cfg.repoRoot, cfg.paths.surfaceDir) });
      await restore();
      if (r.code !== 0) return { ok: false, reason: "integration re-verify failed", misSlice: true };
      return { ok: true };
    },

    async teardownWorktree(worktree, branch) {
      await bunRun(["git", "worktree", "remove", "--force", worktree], { cwd: cfg.repoRoot });
      await rm(worktree, { recursive: true, force: true }).catch(() => {});
      await bunRun(["git", "branch", "-D", branch], { cwd: cfg.repoRoot });
    },

    async assertCleanFn(unitBranch) {
      // Assert the UNIT's own branch is gone — NOT the integration branch (the output).
      // v1 is single-session serial: assertClean's stray-worktree scan is global, so a
      // concurrent session's worktree could false-positive here — acceptable under the
      // serial design (only the unit's own orphan branch is the real signal).
      const r = await assertClean(unitBranch);
      return { ok: r.ok, detail: r.detail };
    },

    notify: cfg.notify,

    async landFn(integrationBranch, landBranch) {
      // Merge the integration branch into the land branch, then push — pushing main
      // auto-deploys organs via Vercel. The original branch is restored after. Never
      // throws: an autonomous push the auto-mode classifier blocks returns ok:false
      // (the work is safe on the integration branch regardless).
      const orig = await bunRun(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: cfg.repoRoot });
      const originalRef = orig.code === 0 && orig.stdout.trim() ? orig.stdout.trim() : cfg.baseRef;
      const co = await bunRun(["git", "checkout", landBranch], { cwd: cfg.repoRoot });
      if (co.code !== 0) return { ok: false, reason: `cannot checkout ${landBranch}` };
      const merge = await bunRun(["git", "merge", "--no-ff", "--no-edit", integrationBranch], { cwd: cfg.repoRoot });
      if (merge.code !== 0) {
        await bunRun(["git", "merge", "--abort"], { cwd: cfg.repoRoot });
        await bunRun(["git", "checkout", originalRef], { cwd: cfg.repoRoot });
        return { ok: false, reason: "land merge conflict" };
      }
      const push = await bunRun(["git", "push", "origin", landBranch], { cwd: cfg.repoRoot });
      await bunRun(["git", "checkout", originalRef], { cwd: cfg.repoRoot });
      if (push.code !== 0) {
        return {
          ok: false,
          reason: `push to ${landBranch} failed (classifier/network?): ${push.stderr.trim().split("\n").slice(-2).join(" | ")}`,
        };
      }
      return { ok: true };
    },

    async preflightFn() {
      // preflight is invoked by the CLI before constructing deps in practice; here we
      // surface a pass-through so the loop's preflight gate has a seam. The CLI may
      // override with the real preflight() call.
      return { ok: true };
    },

    async appendLessonFn(line) {
      // The loop passes a "[tag] rule" line; appendLesson wants { tag, rule }.
      const m = line.match(/^\[([^\]]+)\]\s*(.*)$/);
      const lesson = m ? { tag: m[1].trim(), rule: m[2].trim() } : { tag: "general", rule: line };
      await appendLesson(cfg.lessonsPath, lesson);
    },

    async appendDigestFn(rec) {
      await appendDigest(cfg.runLogPath, rec);
    },

    // The real in-drain early-stop oracle (spec 5.4). Evaluates every success criterion via
    // evaluateCheckSpec, then reduces with goalMet over the TARGET set (omitted => all REQUIRED
    // ids — back-compat). NOT executed in unit tests; the reducer (goalMet) and the evaluator
    // (evaluateCheckSpec) are each tested in isolation.
    async briefSatisfied(brief, target) {
      const sc = SURFACES[cfg.surface];
      const surface = sc
        ? { dir: resolve(cfg.repoRoot, sc.dir), env: sc.env, chain: sc.chain }
        : undefined;
      const checked: Record<string, boolean> = {};
      for (const c of brief.successCriteria) {
        const { pass } = await evaluateCheckSpec(c.check, { repoRoot: cfg.repoRoot, run: bunRun, surface });
        checked[c.id] = pass;
      }
      const allRequiredIds = new Set(brief.successCriteria.filter((c) => c.required).map((c) => c.id));
      return goalMet(checked, target ?? allRequiredIds);
    },

    loadBrief: realLoadBrief,
  };
}
