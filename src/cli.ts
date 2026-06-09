#!/usr/bin/env bun
// src/cli.ts — the generic thebashway CLI.
//
// Loads a project's thebashway.config.ts, injects it (setBinding), and dispatches
// the modes + helpers. There is NO lifeofbash-specific wiring here: paths come from
// the binding, and sinks (notify/event/status) default to no-ops unless the binding
// opts in. Entry: `thebashway <subcommand>` (or `bun run src/cli.ts ...`).
//
//   init                     scaffold thebashway.config.ts + local store (plug-and-play)
//   fix <target> [flags]     FIX MODE  — audit a target, then build the findings
//   build "<feature>" [flags] BUILD MODE — design → decompose → gate → build
//   "<request>"              auto-route to build or fix
//   drain [N] [flags]        run the OUT-door loop over the queue
//   audit <target> [flags]   IN-door directed audit (enqueue only)
//   audit-plan <target>      print the resolved plan (spawn-free)
//   verify [<surface>]       run the per-surface gate (binding-derived repoRoot + manifest)
//   preflight/claim/park/done/add/mark-ready/sweep/intake-list/intake-defer/
//   seed-worktree/spawn-worktree/enqueue-findings   interactive in-session driver verbs

import { resolve, join, isAbsolute } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { setBinding, getRequireBrief, getDefaultSurface } from "./engine/config";
import { gapsOf } from "./engine/brief";
import { writeConfirmedBrief, parseBriefWritePayload, briefGateDecision, briefStatusLines } from "./brief-writer";
import { noopSinks, type Notify } from "./sinks";
import type { ProjectBinding, ResolvedBinding } from "./binding";
import { classifyMode, defaultClassifyModeDeps } from "./router";
import { runInit, initMessage, seedBriefIfAbsent } from "./init";
import { loadBrief } from "./engine/load-brief";
import { runUpdate, type Runner } from "./update";
import { preflight, type PreflightSurface } from "./engine/preflight";
import { seedWorktree, spawnWorktree } from "./engine/worktree-seed";
import { claimNextN, markDone, appendCapture, markReady, recordOpenQuestion, enqueueFindings } from "./engine/queue-ops";
import { parseQueue, type QueueItem, type QueueStatus } from "./engine/queue";
import { queueView, type SurfaceLane } from "./engine/queue-view";
import { appendDecision } from "./engine/lessons";
import { runSweep } from "./engine/capture-sweep";
import { listIntakeCandidates } from "./engine/auto-intake";
import { runVerify } from "./engine/verify/index";
import { z } from "zod";
import { spawnSync } from "node:child_process";
import { resolveTarget, effectiveQueueStatus, CompletableItemSchema } from "./engine/audit";
import { drain, defaultDrainDeps, drainPaths, type DrainDeps } from "./engine/drain";
import { runAudit, defaultAuditDeps } from "./engine/audit-run";
import { runFeatureDesign, defaultDesignDeps } from "./engine/design-run";
import { gitHead, bunRun } from "./engine/verify/run";
import { runToGoal, type RunToGoalDeps } from "./engine/autonomous";
import { evaluateCheckSpec } from "./engine/brief-eval";
import { emitPark, emitUnparkScan, type ParkEvent } from "./engine/park";
import { appendReflection } from "./engine/digest";
import { runReflect } from "./engine/reflect";
import { SURFACES } from "./engine/config";

// ---------------------------------------------------------------------------
// Binding loading + path derivation (pure-ish, unit-tested)
// ---------------------------------------------------------------------------

export interface DerivedPaths {
  repoRoot: string;
  queuePath: string;
  runLogPath: string;
  /** Always-on attention surface the park flow refreshes (binding.paths.now, default .thebashway/NOW.md). */
  nowPath: string;
  /** Where the verify gate writes its manifest (binding.paths.manifest). */
  manifestPath: string;
  lessonsPath: string;
  decisionsPath: string;
  briefPath: string;
  globalLessons: string | null;
}

export function derivePaths(binding: ProjectBinding): DerivedPaths {
  const root = binding.repoRoot;
  const rel = (p: string) => (isAbsolute(p) ? p : join(root, p));
  const paths = binding.paths ?? {};
  return {
    repoRoot: root,
    queuePath: rel(paths.queue ?? ".thebashway/queue.md"),
    runLogPath: rel(paths.runLog ?? ".thebashway/run-log.md"),
    nowPath: rel(paths.now ?? ".thebashway/NOW.md"),
    manifestPath: rel(paths.manifest ?? ".thebashway/.verify-manifest.json"),
    lessonsPath: rel(binding.learning.local),
    decisionsPath: rel(binding.learning.decisions),
    briefPath: rel(binding.learning.brief ?? ".thebashway/brief.ts"),
    globalLessons: binding.learning.global ?? null,
  };
}

export interface LoadedBinding {
  binding: ResolvedBinding;
  paths: DerivedPaths;
}

/** Import the project's thebashway.config.ts and inject it. */
export async function loadBinding(opts: { cwd: string; configPath?: string }): Promise<LoadedBinding> {
  const configPath = opts.configPath
    ? resolve(opts.cwd, opts.configPath)
    : join(opts.cwd, "thebashway.config.ts");
  if (!existsSync(configPath)) {
    throw new Error(`no binding found at ${configPath} — run \`thebashway init\` first`);
  }
  const mod = await import(pathToFileURL(configPath).href);
  const binding = (mod.default ?? mod.binding) as ResolvedBinding;
  if (!binding || !binding.surfaces) {
    throw new Error(`${configPath} does not export a thebashway binding (export default or export const binding)`);
  }
  setBinding(binding);
  return { binding, paths: derivePaths(binding) };
}

function notifyOf(binding: ProjectBinding): Notify {
  return binding.sinks?.notify ?? noopSinks().notify;
}

// Tabby-style self-signed TLS guard for this process's own fetches (best-effort).
function tlsGuard(): void {
  if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdInit(cwd: string, args: string[]): Promise<number> {
  const gIdx = args.indexOf("--global");
  const globalLessons = gIdx >= 0 ? args[gIdx + 1] : null;
  const enablePlugin = !args.includes("--no-enable-plugin");
  const r = await runInit(cwd, { globalLessons, enablePlugin });
  console.log(initMessage(r));
  return r.prereqs.git ? 0 : 1;
}

function cmdUpdate(): number {
  // The package clone's root: this file is src/cli.ts, so ".." is the repo root. Every project
  // references this one clone — updating here updates them all; per-project config/state is untouched.
  const pkgRoot = new URL("..", import.meta.url).pathname;
  const run: Runner = (cmd, a, cwd) => {
    const r = spawnSync(cmd, a, { cwd, encoding: "utf8" });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const report = runUpdate({ pkgRoot, run });
  console.log(report.message);
  return report.ok ? 0 : 1;
}

async function cmdAuditPlan(cwd: string, target: string, configPath?: string): Promise<number> {
  await loadBinding({ cwd, configPath });
  console.log(JSON.stringify(resolveTarget(target), null, 2));
  return 0;
}

/**
 * BRIEF: the non-interactive companion to the conversational interview (which lives in SKILL.md,
 * not here — every CLI command is cmd(cwd,args):Promise<number> with no stdin/readline). It
 * (re)seeds the draft if missing and prints the draft path + the gap list the agent should walk
 * through. It never silently auto-authors a confirmed brief.
 */
async function cmdBrief(cwd: string, _args: string[], configPath?: string): Promise<number> {
  const lb = await loadBinding({ cwd, configPath });
  const briefPath = lb.paths.briefPath;
  const seeded = seedBriefIfAbsent(lb.paths.repoRoot, briefPath);
  if (seeded.created) {
    console.log(`Drafted ${briefPath} from the repo.`);
  } else {
    console.log(`Brief: ${briefPath}`);
  }
  const loaded = await loadBrief(briefPath);
  if (loaded.status === "unparseable") {
    console.log(`! Brief exists but does not parse (${loaded.errors.join("; ")}). Fix it before the interview.`);
    return 1;
  }
  const readiness = loaded.brief ? gapsOf(loaded.brief) : { gaps: seeded.gaps, coreComplete: false, autonomousReady: false, confirmed: false };
  for (const line of briefStatusLines(readiness)) console.log(line);
  return 0;
}

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

/** Build the DrainDeps for a surface from the loaded binding. */
function drainDepsFor(lb: LoadedBinding, surface: string, baseRef: string, notify: Notify): DrainDeps {
  return defaultDrainDeps({
    surface,
    repoRoot: lb.paths.repoRoot,
    baseRef,
    notify,
    seedPaths: lb.binding.seedPaths ?? [],
    runLogPath: lb.paths.runLogPath,
    lessonsPath: lb.paths.lessonsPath,
    // Binding-derived OUT-door paths (surfaceDir / manifestRel / nodeModulesLinks) — the loop
    // runs on this repo's real layout, not a hardcoded "tools".
    paths: drainPaths(lb.binding, surface),
  });
}

/** FIX MODE: audit a target → enqueue findings → drain (build them). */
async function cmdFix(cwd: string, args: string[], configPath?: string): Promise<number> {
  const target = args.find((a) => !a.startsWith("--")) ?? ".";
  const dryRun = args.includes("--dry-run");
  const designMode = args.includes("--design");
  const land = !args.includes("--no-land");
  const lb = await loadBinding({ cwd, configPath });
  const gate = await briefGate(lb, args);
  if (!gate.pass) { console.error(gate.message); return 1; }
  tlsGuard();

  const plan = resolveTarget(target);
  if (designMode) {
    console.log("fix --design: studying design quality (design findings are advisory → always @needs-intake).");
  }
  const auditDeps = defaultAuditDeps({
    repoRoot: lb.paths.repoRoot,
    decisionsPath: lb.paths.decisionsPath,
    surface: plan.surface,
    auditKind: designMode ? "design" : "correctness",
    briefPath: lb.paths.briefPath,
    notify: notifyOf(lb.binding),
  });
  const audit = await runAudit(
    { target, queuePath: lb.paths.queuePath, repoRoot: lb.paths.repoRoot, decisionsPath: lb.paths.decisionsPath, dryRun },
    auditDeps,
  );
  console.log(`fix: audited ${target} (${audit.plan.surface}) → ${audit.shaped.length} item(s), queued ${audit.enqueued?.appended ?? 0}`);
  if (dryRun || !audit.enqueued?.buildReady) {
    console.log(dryRun ? "dry-run — nothing built" : "no build-ready findings — nothing to drain");
    return 0;
  }

  const baseRef = await gitHead(lb.paths.repoRoot);
  const notify = notifyOf(lb.binding);
  const deps: DrainDeps = {
    ...drainDepsFor(lb, plan.surface, baseRef, notify),
    preflightFn: async () => ({ ok: true }),
  };
  const report = await drain(
    { surface: plan.surface, queuePath: lb.paths.queuePath, repoRoot: lb.paths.repoRoot, session: "fix", land },
    deps,
  );
  console.log(report.landResult ? (report.landed ? `✓ ${report.landResult}` : `• ${report.landResult}`) : `drained ${report.succeeded.length}`);
  return report.breakerTripped ? 1 : 0;
}

/** BUILD MODE: design a feature → decompose → gate → build. */
async function cmdBuild(cwd: string, args: string[], configPath?: string): Promise<number> {
  const description = args.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!description) {
    console.error('build: describe the feature, e.g. thebashway build "add a CSV export button"');
    return 2;
  }
  const dryRun = args.includes("--dry-run");
  const noDrain = args.includes("--no-drain");
  const noLand = args.includes("--no-land");
  const lb = await loadBinding({ cwd, configPath });
  const gate = await briefGate(lb, args);
  if (!gate.pass) { console.error(gate.message); return 1; }
  tlsGuard();

  const baseRef = await gitHead(lb.paths.repoRoot);
  const noopNotify: Notify = async () => {};
  const runDrainStaged = (surface: string, n: number, allowTitles: string[]) =>
    drain(
      { surface, queuePath: lb.paths.queuePath, repoRoot: lb.paths.repoRoot, n, claimTitles: allowTitles, session: "build", land: false, noPreflight: true },
      drainDepsFor(lb, surface, baseRef, noopNotify),
    );
  const landIntegration = (integrationBranch: string, landBranch: string) =>
    drainDepsFor(lb, lb.binding.defaultSurface, baseRef, noopNotify).landFn(integrationBranch, landBranch);

  const deps = defaultDesignDeps({
    repoRoot: lb.paths.repoRoot,
    decisionsPath: lb.paths.decisionsPath,
    notify: notifyOf(lb.binding),
    runDrainStaged,
    landIntegration,
    briefPath: lb.paths.briefPath,
  });

  const report = await runFeatureDesign(
    { description, queuePath: lb.paths.queuePath, repoRoot: lb.paths.repoRoot, decisionsPath: lb.paths.decisionsPath, briefPath: lb.paths.briefPath, dryRun, noDrain, noLand },
    deps,
  );
  if (report.aborted) {
    console.error(`build aborted: ${report.aborted}`);
    return 1;
  }
  if (report.design) console.log(`build "${report.design.title}" → ${report.surface}: ${report.design.summary}`);
  for (const t of report.tasks) console.log(`  - ${t.title} [${effectiveQueueStatus(t, { freezeAuthorized: true })}]`);
  console.log(report.summary);
  return 0;
}

/** The shared human-gate park closure: emitPark across queue.md + NOW.md + the optional external
 *  sink. Reused by run-to-goal AND the milestone reflection — there is ONE park path, never a
 *  brief writer (INV-A). */
function emitParkFor(lb: LoadedBinding): (title: string, reason: string) => Promise<void> {
  const nowPath = lb.paths.nowPath;
  const eventSink = lb.binding.sinks?.eventSink;
  return async (title, reason) => {
    await emitPark(title, reason, {
      queuePath: lb.paths.queuePath,
      nowPath,
      emitExternal: eventSink
        ? async (e, kind) => {
            await eventSink({ action: kind, target: e.item, reason: e.reason, cascade: e.cascade });
          }
        : undefined,
    });
  };
}

/**
 * MILESTONE REFLECTION (Loop C — spec 5.5). The proposedUpdate path (incl. conventions/glossary
 * growth) fires ONLY on an EXPLICIT milestone marker, is RATE-LIMITED (no new proposal while one is
 * parked), and BATCHES growth into the single proposal. It routes via emitPark/sinks + appendReflection
 * — there is NO writeFileSync(briefPath) (INV-A): the engine cannot write the brief; a human acts on
 * the parked proposal before any human-present writer touches brief.ts.
 */
async function runMilestoneReflection(
  lb: LoadedBinding,
  opts: {
    milestone: string;
    learned: string[];
    briefStillValid: boolean;
    onPath: boolean;
    driftedCriteria?: string[];
    isMilestone: boolean;
    proposedUpdate?: string;
    proposedConventions?: string[];
    proposedGlossary?: { term: string; means: string }[];
  },
): Promise<void> {
  const park = emitParkFor(lb);
  const res = await runReflect(
    {
      ...opts,
      logPath: lb.paths.runLogPath,
      queuePath: lb.paths.queuePath,
    },
    {
      appendReflection,
      emitPark: park,
      readQueue: async (queuePath) => {
        const f = Bun.file(queuePath);
        return (await f.exists()) ? await f.text() : "";
      },
    },
  );
  console.log(
    res.parked
      ? `reflect "${opts.milestone}": brief-update proposal PARKED for your review (human-gated; not written).`
      : `reflect "${opts.milestone}": logged${res.suppressedReason ? ` (no park: ${res.suppressedReason})` : ""}.`,
  );
}

/**
 * AUTONOMOUS-TO-GOAL (spec 5.4): re-invoke the drain until the brief's target slice (or the whole
 * required set) is met, under REQUIRED caps. `--target <id,…>` aims at a slice (PART); omitted =
 * all required ids (ALL). `--milestone <label>` marks this run as an epic-completion milestone so a
 * successful terminal fires the Loop-C reflection (a brief-update proposal routes via emitPark/sinks
 * — NEVER an auto `git push origin main`, memory main-branch-classifier-gate).
 */
async function cmdRunToGoal(cwd: string, args: string[], configPath?: string): Promise<number> {
  const lb = await loadBinding({ cwd, configPath });
  const gate = await briefGate(lb, args);
  if (!gate.pass) { console.error(gate.message); return 1; }
  tlsGuard();

  const tIdx = args.indexOf("--target");
  const targetCriteria =
    tIdx >= 0 && args[tIdx + 1]
      ? args[tIdx + 1]!.split(",").map((s) => s.trim()).filter(Boolean) // truthy check above
      : undefined;
  const mIdx = args.indexOf("--milestone");
  const milestone = mIdx >= 0 ? args[mIdx + 1] : undefined;
  const surface = lb.binding.defaultSurface;
  const baseRef = await gitHead(lb.paths.repoRoot);
  const notify = notifyOf(lb.binding);

  // The EvalCtx the termination ORACLE runs criteria under (surface chain for `verify` checks).
  const sc = SURFACES[surface];
  const evalSurface = sc ? { dir: resolve(lb.paths.repoRoot, sc.dir), env: sc.env, chain: sc.chain } : undefined;

  const deps: RunToGoalDeps = {
    loadBrief,
    evaluateCheckSpec,
    evalCtx: { repoRoot: lb.paths.repoRoot, run: bunRun, surface: evalSurface },
    runDrain: (o) => drain(o, drainDepsFor(lb, o.surface, baseRef, notify)),
    runAudit: (o) =>
      runAudit(
        o,
        defaultAuditDeps({
          repoRoot: lb.paths.repoRoot,
          decisionsPath: lb.paths.decisionsPath,
          surface,
          briefPath: lb.paths.briefPath,
          notify,
        }),
      ),
    notify,
    emitPark: emitParkFor(lb),
    now: Date.now,
  };

  const result = await runToGoal(
    {
      surface,
      queuePath: lb.paths.queuePath,
      repoRoot: lb.paths.repoRoot,
      briefPath: lb.paths.briefPath,
      decisionsPath: lb.paths.decisionsPath,
      targetCriteria,
      // `--no-land`: each iteration's drain stages at its green integration branch instead of
      // merging to main + pushing (parity with fix/build/drain). Threaded via drainOpts.land,
      // which buildDrainOpts spreads first and never overrides.
      drainOpts: args.includes("--no-land") ? { land: false } : undefined,
      // REQUIRED caps (memory bashir-cost-sensitive): three independent axes. maxIterations
      // (default 5, in runToGoal) bounds drain passes; maxWallClockMs is the time backstop;
      // costCeiling bounds the cumulative BUILD BASHAS spawned (the real LLM-spend driver) — a
      // distinct axis that can bite before 5 iterations when drains are productive.
      maxWallClockMs: 60 * 60_000,
      costCeiling: 12,
    },
    deps,
  );

  console.log(
    `run-to-goal: ${result.reason} (goalMet=${result.goalMet}, built ${result.built} in ${result.iterations} iter; target [${result.target.join(", ") || "—"}])`,
  );
  if (result.failingRequired.length) {
    console.log(`  still-failing required: ${result.failingRequired.join(", ")}`);
  }

  // Loop C (spec 5.5): the EXPLICIT milestone marker fires the reflection. A successful terminal is
  // the epic-completion signal; the per-feature lands inside drain do NOT propose (lightweight only).
  // The reflection logs the note and — rate-limited/batched — parks a brief-update proposal. Without
  // --milestone, run-to-goal never proposes a brief change (no propose-after-every-feature drip).
  if (milestone) {
    await runMilestoneReflection(lb, {
      milestone,
      learned: [`run-to-goal terminal: ${result.reason}`, `built ${result.built} item(s) in ${result.iterations} iteration(s)`],
      briefStillValid: true,
      onPath: result.failingRequired.length === 0,
      driftedCriteria: result.failingRequired.length ? result.failingRequired : undefined,
      isMilestone: true,
    });
  }

  return result.goalMet ? 0 : 1;
}

/**
 * REFLECT (Loop C — spec 5.5): the explicit milestone marker. `--milestone <label>` (or `--epic`)
 * marks an epic-completion milestone — the ONLY trigger for a brief-update proposal; without it the
 * reflection logs a LIGHTWEIGHT per-feature note and NEVER parks a proposal. `--learned "<note>"`
 * (repeatable), `--propose "<delta>"` stage a batched proposal. The proposal routes via emitPark/sinks
 * + the run log — NEVER writeFileSync(briefPath) (INV-A): a human acts on the parked proposal before
 * any human-present writer touches brief.ts.
 */
async function cmdReflect(cwd: string, args: string[], configPath?: string): Promise<number> {
  const lb = await loadBinding({ cwd, configPath });
  const flagVal = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const flagVals = (flag: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) if (args[i] === flag && args[i + 1]) out.push(args[i + 1]!); // truthy check above
    return out;
  };
  const milestone = flagVal("--milestone") ?? flagVal("--epic");
  const isMilestone = args.includes("--milestone") || args.includes("--epic");
  const learned = flagVals("--learned");
  const proposedUpdate = flagVal("--propose");
  const label = milestone ?? "feature land";

  await runMilestoneReflection(lb, {
    milestone: label,
    learned,
    briefStillValid: true,
    onPath: true,
    isMilestone,
    proposedUpdate,
  });
  return 0;
}

// ---------------------------------------------------------------------------
// Granular driver verbs — the interactive in-session build loop. Each loads the
// binding, reads paths + sinks from it, and hardcodes no project infra. These expose
// the loop's internals as commands so an agent can drive it step by step (the
// interactive method); the higher-level fix/build/run-to-goal use them internally.
// ---------------------------------------------------------------------------

function sessionId(argSession?: string): string {
  return argSession || process.env.CLAUDE_SESSION_ID || process.env.USER || "anon";
}

/** Adapt the binding's eventSink to emitPark's emitExternal callback (undefined → no external emit). */
function eventEmitter(lb: LoadedBinding): ((e: ParkEvent, kind: "parked" | "unparked") => Promise<void>) | undefined {
  const eventSink = lb.binding.sinks?.eventSink;
  if (!eventSink) return undefined;
  return async (e, kind) => {
    await eventSink({ action: kind, target: e.item, reason: e.reason, cascade: e.cascade });
  };
}

async function cmdPreflight(cwd: string, surfaceName: string, configPath?: string): Promise<number> {
  const lb = await loadBinding({ cwd, configPath });
  const cfg = lb.binding.surfaces[surfaceName];
  if (!cfg) {
    console.error(`unknown surface: ${surfaceName} (configured: ${Object.keys(lb.binding.surfaces).join(", ")})`);
    return 2;
  }
  const surface: PreflightSurface = {
    name: surfaceName,
    cwd: resolve(lb.paths.repoRoot, cfg.dir),
    repoRoot: lb.paths.repoRoot,
    regen: cfg.regen ?? undefined,
    derived: cfg.derived ?? [],
    branchPattern: lb.binding.branchPattern,
    seedPaths: lb.binding.seedPaths ?? [],
  };
  const r = await preflight(surface);
  for (const c of r.checks) console.log(`  ${c.ok ? "ok" : "x"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  return r.ok ? 0 : 1;
}

async function cmdClaim(cwd: string, nRaw: number, session: string, configPath?: string): Promise<number> {
  const lb = await loadBinding({ cwd, configPath });
  const cap = lb.binding.maxConcurrent;
  const n = Math.max(1, Math.min(cap, nRaw || cap));
  const claimed = await claimNextN(
    n,
    session,
    (it) => `${(lb.binding.branchPattern || "tbw/*").replace(/\*$/, "")}${it.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
    lb.paths.queuePath,
  );
  console.log(JSON.stringify(claimed, null, 2));
  return claimed.length > 0 ? 0 : 1;
}

async function cmdPark(cwd: string, title: string, reason: string, configPath?: string): Promise<number> {
  const lb = await loadBinding({ cwd, configPath });
  const evt = await emitPark(title, reason, {
    queuePath: lb.paths.queuePath,
    nowPath: lb.paths.nowPath,
    emitExternal: eventEmitter(lb),
  });
  console.log(`parked: ${evt.item}${evt.cascade.length ? ` (cascade: ${evt.cascade.join(", ")})` : ""}`);
  return 0;
}

async function cmdUnparkScan(cwd: string, configPath?: string): Promise<number> {
  const lb = await loadBinding({ cwd, configPath });
  const unparked = await emitUnparkScan({
    queuePath: lb.paths.queuePath,
    nowPath: lb.paths.nowPath,
    emitExternal: eventEmitter(lb),
  });
  console.log(unparked.length ? `unparked: ${unparked.join(", ")}` : "nothing to unpark");
  return 0;
}

async function cmdDone(cwd: string, title: string, configPath?: string): Promise<number> {
  const lb = await loadBinding({ cwd, configPath });
  const ok = await markDone(title, lb.paths.queuePath);
  console.log(ok ? `done: ${title}` : `not found: ${title}`);
  return ok ? 0 : 1;
}

async function cmdAdd(cwd: string, title: string, configPath?: string): Promise<number> {
  const lb = await loadBinding({ cwd, configPath });
  await appendCapture({ title }, lb.paths.queuePath);
  console.log(`captured (needs-intake): ${title}`);
  return 0;
}

async function cmdMarkReady(cwd: string, title: string, configPath?: string): Promise<number> {
  const lb = await loadBinding({ cwd, configPath });
  const ok = await markReady(title, lb.paths.queuePath);
  console.log(ok ? `build-ready: ${title}` : `not a needs-intake item: ${title}`);
  return ok ? 0 : 1;
}

async function cmdSweep(cwd: string, max: number | undefined, dryRun: boolean, configPath?: string): Promise<number> {
  const lb = await loadBinding({ cwd, configPath });
  if (!lb.binding.sweep) {
    console.error("sweep: this binding declares no sweep config");
    return 2;
  }
  const cfg = max != null ? { ...lb.binding.sweep, maxPerSweep: max } : lb.binding.sweep;
  const r = await runSweep({ repoRoot: lb.paths.repoRoot, queuePath: lb.paths.queuePath, config: cfg, dryRun });
  console.log(
    `sweep: ${dryRun ? "would capture" : "captured"} ${r.appended.length}` +
      ` (skipped ${r.skippedExisting.length} already-queued, ${r.skippedBudget.length} over budget)`,
  );
  for (const c of r.appended) console.log(`  + ${c.title}  [${c.source}]`);
  if (r.skippedBudget.length) console.log(`  … ${r.skippedBudget.length} over the per-sweep cap (${cfg.maxPerSweep}); re-run after triage`);
  if (r.backlogWarn) console.log(`  ! @needs-intake backlog is ${r.backlog} (> ${cfg.backlogWarnAt}); triage before sweeping more`);
  return 0;
}

async function cmdIntakeList(cwd: string, asJson: boolean, configPath?: string): Promise<number> {
  const lb = await loadBinding({ cwd, configPath });
  const cands = await listIntakeCandidates({
    queuePath: lb.paths.queuePath,
    decisionsPath: lb.paths.decisionsPath,
    surfaces: SURFACES,
  });
  if (asJson) {
    console.log(JSON.stringify(cands, null, 2));
    return 0;
  }
  if (!cands.length) {
    console.log("no @needs-intake items");
    return 0;
  }
  for (const c of cands) {
    const open = c.item.openQuestion ? `  (open: ${c.item.openQuestion})` : "";
    console.log(`- ${c.item.title}  [areas: ${c.areas.join(", ") || "none"}]${open}`);
  }
  return 0;
}

async function cmdIntakeDefer(cwd: string, title: string, question: string, configPath?: string): Promise<number> {
  const lb = await loadBinding({ cwd, configPath });
  const ok = await recordOpenQuestion(title, question, lb.paths.queuePath);
  console.log(ok ? `deferred (needs human): ${title}\n  open-question: ${question}` : `not a needs-intake item: ${title}`);
  return ok ? 0 : 1;
}

async function cmdEnqueueFindings(cwd: string, filePath: string, configPath?: string): Promise<number> {
  const lb = await loadBinding({ cwd, configPath });
  const absPath = resolve(cwd, filePath);
  const file = Bun.file(absPath);
  if (!(await file.exists())) {
    console.error(`enqueue-findings: file not found: ${absPath}`);
    return 1;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch (e) {
    console.error(`enqueue-findings: invalid JSON in ${absPath}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const parsed = z.array(CompletableItemSchema).safeParse(raw);
  if (!parsed.success) {
    console.error(`enqueue-findings: schema validation failed:\n${parsed.error.message}`);
    return 1;
  }
  const items = parsed.data;
  if (items.length === 0) {
    console.log("enqueue-findings: no items in file — nothing to do");
    return 0;
  }
  const result = await enqueueFindings(items, lb.paths.queuePath);
  const appendedItems = result.appended as Array<z.infer<typeof CompletableItemSchema> & { source: string }>;
  const buildReadyCount = appendedItems.filter((i) => effectiveQueueStatus(i) === "unclaimed").length;
  console.log(
    `enqueue-findings: queued ${appendedItems.length} (${buildReadyCount} build-ready, ${appendedItems.length - buildReadyCount} need input) from ${items.length} items`,
  );
  for (const item of appendedItems) console.log(`  + ${item.title}  [${effectiveQueueStatus(item)}]`);
  if (result.skippedExisting.length) console.log(`  (${result.skippedExisting.length} already present in queue — skipped)`);
  return 0;
}

/**
 * LOOP A WRITER: `add-decision "<rule>" [--tag <tag>]`. Records a decision-default into the
 * binding's `decisions.md` (the human/agent-driven mirror of the drain's auto Loop B lesson
 * capture). A `[tag]`-prefixed positional (`add-decision "[tools] prefer X"`) is parsed; `--tag`
 * overrides; with neither, the tag defaults to `decision` (the always-on global tier). Dedups.
 */
async function cmdAddDecision(cwd: string, args: string[], configPath?: string): Promise<number> {
  const tagFlag = args.indexOf("--tag");
  const flagTag = tagFlag >= 0 ? args[tagFlag + 1] : undefined;
  const skip = new Set<number>();
  if (tagFlag >= 0) { skip.add(tagFlag); skip.add(tagFlag + 1); }
  const positional = args.filter((a, i) => !skip.has(i) && !a.startsWith("--")).join(" ").trim();
  if (!positional) {
    console.error('add-decision: pass the rule, e.g. thebashway add-decision "prefer X over Y" --tag tools');
    return 2;
  }
  // An explicit `[tag] rule` form is parsed (the same shape the drain's appendLessonFn uses).
  const m = positional.match(/^\[([^\]]+)\]\s*(.*)$/);
  const tag = flagTag?.trim() || (m ? m[1]!.trim() : undefined); // group 1 exists after match
  const rule = (m ? m[2]! : positional).trim(); // group 2 exists after match
  if (!rule) {
    console.error("add-decision: empty rule");
    return 2;
  }
  const lb = await loadBinding({ cwd, configPath });
  const wrote = await appendDecision(lb.paths.decisionsPath, { tag, rule });
  console.log(wrote ? `recorded decision [${tag || "decision"}]: ${rule}` : `already recorded (no-op): ${rule}`);
  return 0;
}

// ---------------------------------------------------------------------------
// PER-SURFACE QUEUE VIEW: `queue [--surface <s>] [--json]`. A read-only split of the one
// queue into per-surface build lanes (+ unrouted / other buckets). Reuses the same inSurface
// predicate the drain claim path uses, so the view can't drift from what `drain --surface` claims.
// ---------------------------------------------------------------------------

const QUEUE_STATUS_ORDER: QueueStatus[] = ["unclaimed", "claimed", "blocked", "parked", "parked-on", "needs-intake", "done"];
const QUEUE_STATUS_LABEL: Record<QueueStatus, string> = {
  unclaimed: "build-ready",
  claimed: "in-flight",
  blocked: "blocked",
  parked: "parked",
  "parked-on": "parked-on",
  "needs-intake": "needs-intake",
  done: "done",
};

function groupByStatus(items: QueueItem[]): Map<QueueStatus, QueueItem[]> {
  const m = new Map<QueueStatus, QueueItem[]>();
  for (const it of items) {
    const arr = m.get(it.status) ?? [];
    arr.push(it);
    m.set(it.status, arr);
  }
  return m;
}

function printLane(label: string, items: QueueItem[]): void {
  const groups = groupByStatus(items);
  const counts = QUEUE_STATUS_ORDER.filter((s) => groups.get(s)?.length).map((s) => `${groups.get(s)!.length} ${QUEUE_STATUS_LABEL[s]}`);
  console.log(`${label}: ${items.length} item(s)${counts.length ? ` — ${counts.join(", ")}` : ""}`);
  for (const s of QUEUE_STATUS_ORDER) {
    for (const it of groups.get(s) ?? []) {
      console.log(`  - ${it.title}  [${QUEUE_STATUS_LABEL[s]}]${it.territory.length ? `  {${it.territory.join(", ")}}` : ""}`);
    }
  }
}

async function cmdQueue(cwd: string, args: string[], configPath?: string): Promise<number> {
  const lb = await loadBinding({ cwd, configPath });
  const asJson = args.includes("--json");
  const surfFlag = args.indexOf("--surface");
  const surfaceName = surfFlag >= 0 ? args[surfFlag + 1] : undefined;
  const f = Bun.file(lb.paths.queuePath);
  const items = (await f.exists()) ? parseQueue(await f.text()) : [];
  const surfaces: SurfaceLane[] = Object.entries(lb.binding.surfaces).map(([name, c]) => ({ name, dir: c.dir }));
  const view = queueView(items, surfaces);
  if (asJson) {
    console.log(JSON.stringify(view, null, 2));
    return 0;
  }
  if (surfaceName) {
    if (!lb.binding.surfaces[surfaceName]) {
      console.error(`unknown surface: ${surfaceName} (configured: ${Object.keys(lb.binding.surfaces).join(", ")})`);
      return 2;
    }
    printLane(surfaceName, view.lanes[surfaceName] ?? []);
    return 0;
  }
  for (const s of surfaces) printLane(s.name, view.lanes[s.name] ?? []);
  if (view.unrouted.length) printLane("unrouted (needs-intake — no build lane yet)", view.unrouted);
  if (view.other.length) printLane("other (spans / under no surface)", view.other);
  return 0;
}

async function cmdSeedWorktree(cwd: string, workPath: string, configPath?: string): Promise<number> {
  const lb = await loadBinding({ cwd, configPath });
  const paths = lb.binding.seedPaths ?? [];
  if (paths.length === 0) {
    console.log("no seed paths configured");
    return 0;
  }
  const r = await seedWorktree(workPath, lb.paths.repoRoot, paths);
  for (const p of r.copied) console.log(`  ok seeded ${p}`);
  for (const p of r.skipped) console.log(`  ~ ${p} (already present)`);
  for (const p of r.missing) console.log(`  x ${p} (MISSING in repo root)`);
  return r.missing.length ? 1 : 0;
}

async function cmdSpawnWorktree(cwd: string, args: string[], configPath?: string): Promise<number> {
  const workPath = args[0];
  if (!workPath || workPath.startsWith("--")) {
    usage();
    return 2;
  }
  const lb = await loadBinding({ cwd, configPath });
  const refIdx = args.indexOf("--ref");
  const branchIdx = args.indexOf("--branch");
  const ref = refIdx >= 0 ? args[refIdx + 1] : undefined;
  const branch = branchIdx >= 0 ? args[branchIdx + 1] : undefined;
  const install = !args.includes("--no-install");
  const r = await spawnWorktree({ workPath, repoRoot: lb.paths.repoRoot, seedPaths: lb.binding.seedPaths ?? [], ref, branch, install });
  console.log(`spawned worktree at ${r.workPath}${r.branch ? ` (branch ${r.branch})` : ""}; installed=${r.installed}`);
  for (const p of r.seed.copied) console.log(`  ok seeded ${p}`);
  for (const p of r.seed.missing) console.log(`  x ${p} (MISSING in repo root)`);
  return r.seed.missing.length ? 1 : 0;
}

/** The verify gate as a verb: load the binding, run the per-surface checks (binding-derived
 *  repoRoot + manifest path), write the manifest, exit 0/1. */
async function cmdVerify(cwd: string, args: string[], configPath?: string): Promise<number> {
  const lb = await loadBinding({ cwd, configPath });
  const surfFlag = args.indexOf("--surface");
  const surfaceName =
    surfFlag >= 0 ? args[surfFlag + 1] ?? getDefaultSurface() : args.find((a) => !a.startsWith("--")) ?? getDefaultSurface();
  const baseIdx = args.indexOf("--base");
  const base = baseIdx >= 0 ? args[baseIdx + 1] : "HEAD";
  const territory: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--territory" && args[i + 1]) territory.push(args[i + 1]!); // truthy check above
  const json = args.includes("--json");
  try {
    const { manifest } = await runVerify({
      surface: surfaceName,
      repoRoot: lb.paths.repoRoot,
      manifestPath: lb.paths.manifestPath,
      base,
      territory,
      log: !json,
    });
    if (json) console.log(JSON.stringify(manifest, null, 2));
    return manifest.ok ? 0 : 1;
  } catch (err) {
    console.error(`verify error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

/** IN-door directed audit as a standalone verb (the audit half of `fix`): finder bashas ->
 *  adversarial verify -> shape -> enqueue. Lets the interactive method fill the queue, review it,
 *  then drain selectively (the headless `fix` folds audit+drain into one). */
async function cmdAudit(cwd: string, args: string[], configPath?: string): Promise<number> {
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) { usage(); return 2; }
  const dryRun = args.includes("--dry-run");
  const designMode = args.includes("--design");
  const fanoutFlag = args.indexOf("--fanout");
  const fanoutRaw = fanoutFlag >= 0 ? Number(args[fanoutFlag + 1]) : NaN;
  const fanoutMax = Number.isFinite(fanoutRaw) ? fanoutRaw : undefined;
  const lb = await loadBinding({ cwd, configPath });
  tlsGuard();
  const plan = resolveTarget(target);
  if (dryRun) console.log("audit --dry-run: finders/verify/shape STILL run (Opus); only the queue write is skipped.");
  if (designMode) console.log("audit --design: studying design quality (advisory -> always @needs-intake).");
  const deps = defaultAuditDeps({
    repoRoot: lb.paths.repoRoot,
    decisionsPath: lb.paths.decisionsPath,
    surface: plan.surface,
    auditKind: designMode ? "design" : "correctness",
    briefPath: lb.paths.briefPath,
    notify: notifyOf(lb.binding),
  });
  const report = await runAudit(
    { target, queuePath: lb.paths.queuePath, repoRoot: lb.paths.repoRoot, decisionsPath: lb.paths.decisionsPath, dryRun, fanoutMax },
    deps,
  );
  console.log(`audit ${target} (${report.plan.surface}) — ${report.plan.subAreas.length} sub-areas`);
  console.log(`  findings ${report.findingCount} -> confirmed ${report.confirmedCount} -> shaped ${report.shaped.length}`);
  if (report.downgradedLowConfidence) console.log(`  ${report.downgradedLowConfidence} downgraded to needs-intake`);
  if (report.droppedOverCap) console.log(`  dropped ${report.droppedOverCap} over the per-audit cap`);
  for (const item of report.shaped) console.log(`  - ${item.title}  [${effectiveQueueStatus(item)}]`);
  if (report.enqueued) {
    const skip = report.enqueued.skippedExisting ? `; ${report.enqueued.skippedExisting} already present` : "";
    console.log(`queued ${report.enqueued.appended} (${report.enqueued.buildReady} build-ready, ${report.enqueued.needInput} need input)${skip}`);
  } else {
    console.log(`dry-run — nothing written (would queue ${report.shaped.length})`);
  }
  return 0;
}

/** OUT-door drain as a standalone verb (the drain half of `fix`): preflight -> claim -> build basha
 *  -> re-verify -> integrate -> LAND. `--no-land` stages at a green integration branch. */
async function cmdDrain(cwd: string, args: string[], configPath?: string): Promise<number> {
  const lb = await loadBinding({ cwd, configPath });
  const nArg = args.find((a) => /^\d+$/.test(a));
  const n = nArg ? Number(nArg) : undefined;
  const surfaceFlag = args.indexOf("--surface");
  const surface = surfaceFlag >= 0 ? args[surfaceFlag + 1] ?? lb.binding.defaultSurface : lb.binding.defaultSurface;
  const sessionFlag = args.indexOf("--session");
  const session = sessionFlag >= 0 ? args[sessionFlag + 1] ?? sessionId() : sessionId();
  const dryRun = args.includes("--dry-run");
  const noPreflight = args.includes("--no-preflight");
  const autoBuild = !args.includes("--no-auto-build");
  const land = !args.includes("--no-land");
  const landBranchFlag = args.indexOf("--land-branch");
  const landBranch = landBranchFlag >= 0 ? args[landBranchFlag + 1] : undefined;
  const cfg = lb.binding.surfaces[surface];
  if (!cfg) {
    console.error(`unknown surface: ${surface} (configured: ${Object.keys(lb.binding.surfaces).join(", ")})`);
    return 2;
  }
  tlsGuard();
  const baseRef = await gitHead(lb.paths.repoRoot);
  const notify = notifyOf(lb.binding);
  const realPreflight = async (): Promise<{ ok: boolean; detail?: string }> => {
    const s: PreflightSurface = {
      name: surface,
      cwd: resolve(lb.paths.repoRoot, cfg.dir),
      repoRoot: lb.paths.repoRoot,
      regen: cfg.regen ?? undefined,
      derived: cfg.derived ?? [],
      branchPattern: lb.binding.branchPattern,
      seedPaths: lb.binding.seedPaths ?? [],
    };
    const r = await preflight(s);
    return { ok: r.ok, detail: r.checks.filter((c) => !c.ok).map((c) => c.name).join(", ") || undefined };
  };
  const deps: DrainDeps = { ...drainDepsFor(lb, surface, baseRef, notify), preflightFn: realPreflight };
  const report = await drain(
    { surface, queuePath: lb.paths.queuePath, repoRoot: lb.paths.repoRoot, n, session, dryRun, noPreflight, autoBuild, land, landBranch },
    deps,
  );
  console.log(JSON.stringify(report, null, 2));
  if (report.landResult) console.log(report.landed ? `✓ ${report.landResult}` : `✗ ${report.landResult}`);
  if (report.aborted) {
    console.error(`drain aborted: ${report.aborted}`);
    return 1;
  }
  return report.breakerTripped ? 1 : 0;
}

function usage(): void {
  console.log(`thebashway — autonomous Build + Fix for your repo

  thebashway init [--global <path>] [--no-enable-plugin]
                                         scaffold thebashway.config.ts + .thebashway/ store, and
                                         enable the plugin for THIS repo (.claude/settings.json);
                                         --no-enable-plugin skips the enable (e.g. install.sh users)
  thebashway fix <target> [--dry-run] [--no-land]
                                         FIX: audit a file/dir/registry target, build the findings
  thebashway build "<feature>" [--dry-run] [--no-drain]
                                         BUILD: design a new feature, then build it
  thebashway audit <target> [--dry-run] [--fanout N] [--design]
                                         IN-door: finder bashas -> verify -> shape -> enqueue (audit half of fix)
  thebashway drain [N] [--surface S] [--no-land] [--dry-run] [--no-preflight] [--no-auto-build]
                                         OUT-door: claim -> build basha -> re-verify -> integrate -> land (drain half of fix)
  thebashway "<request>"                 auto-route to build or fix
  thebashway brief                       (re)seed + print the per-project north star draft + its gaps
  thebashway run-to-goal [--target <id,…>] [--milestone <label>] [--no-land]
                                         AUTONOMOUS: re-drain until the brief's target (a slice via
                                         --target, or all required criteria) is met, under caps;
                                         --milestone fires the Loop-C reflection on a successful run
  thebashway reflect --milestone <label> [--learned "<note>"…] [--propose "<delta>"]
                                         LOOP C: log a milestone reflection; --milestone/--epic is the
                                         ONLY trigger that stages a human-gated brief-update proposal
                                         (rate-limited, batched); never writes the brief
  thebashway audit-plan <target>         print the resolved plan (no model calls)
  thebashway verify [<surface>] [--base <ref>] [--territory <glob>…] [--json]
                                         run the per-surface gate (chain/freshness/required-touches/smoke)
  thebashway update                      pull the latest thebashway into this clone (git ff-only + bun install)

  Interactive driver verbs (drive the loop step by step in-session):
  thebashway preflight <surface>         push + regen-commit + clean + seeds
  thebashway claim <n> [--session <id>]  claim up to N build-ready items (prints JSON)
  thebashway park <title> <reason…>      flip @parked + broadcast (queue / NOW / eventSink)
  thebashway unpark-scan                 release dependents whose parent resolved
  thebashway done <title>                mark an item @done
  thebashway add "<title>"               capture a rough item as @needs-intake
  thebashway mark-ready "<title>"        promote a needs-intake item to build-ready
  thebashway add-decision "<rule>" [--tag <tag>]
                                         LOOP A: record a decision-default into decisions.md
                                         (tag defaults to "decision", the always-on tier; dedups)
  thebashway queue [--surface <s>] [--json]
                                         per-surface VIEW of the one queue (build lanes + unrouted/other)
  thebashway sweep [--max N] [--dry-run] scan for TODO(tbw)/FIXME(tbw) → @needs-intake
  thebashway intake-list [--json]        list @needs-intake items + assembled intake prompts
  thebashway intake-defer "<t>" "<q>"    record an open question, keep the item @needs-intake
  thebashway seed-worktree <path>        copy gitignored seed files into a worktree
  thebashway spawn-worktree <path> [--ref R] [--branch B] [--no-install]
                                         git worktree add + install + seed (ready-to-build)
  thebashway enqueue-findings <json>     zod-validate + enqueue completable items from a directed audit

  Common: --config <path>  use a binding other than ./thebashway.config.ts
  Safety: tasks that reach people or destroy data are set aside for your approval.`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function main(argv: string[], cwd: string): Promise<number> {
  // Parse --config from the FULL argv BEFORE extracting the subcommand, so it works whether the flag
  // precedes OR follows the verb. A `bun run` script bakes a fixed `--config <path>` and bun appends
  // the user's verb AFTER it, so the wired `bun run thebashway <verb>` produces config-FIRST argv
  // (`[--config, <path>, <verb>, …]`). Extracting `sub` first would misparse `--config` as the verb.
  const cfgIdx = argv.indexOf("--config");
  const configPath = cfgIdx >= 0 ? argv[cfgIdx + 1] : undefined;
  const stripped = cfgIdx >= 0 ? argv.filter((_, i) => i !== cfgIdx && i !== cfgIdx + 1) : argv;
  const [sub, ...args] = stripped;

  switch (sub) {
    case "init":
      return cmdInit(cwd, args);
    case "update":
      return cmdUpdate();
    case "verify":
      return cmdVerify(cwd, args, configPath);
    case "preflight":
      return args[0] && !args[0].startsWith("--") ? cmdPreflight(cwd, args[0], configPath) : (usage(), 2);
    case "claim": {
      const sFlag = args.indexOf("--session");
      const session = sFlag >= 0 ? args[sFlag + 1] ?? sessionId() : sessionId();
      const nArg = args.find((a) => /^\d+$/.test(a));
      return cmdClaim(cwd, nArg ? Number(nArg) : 0, session, configPath);
    }
    case "park": {
      const title = args[0];
      const reason = args.slice(1).join(" ");
      if (!title || !reason) { usage(); return 2; }
      return cmdPark(cwd, title, reason, configPath);
    }
    case "unpark-scan":
      return cmdUnparkScan(cwd, configPath);
    case "done":
      return args[0] ? cmdDone(cwd, args[0], configPath) : (usage(), 2);
    case "add":
      return args[0] ? cmdAdd(cwd, args.join(" "), configPath) : (usage(), 2);
    case "mark-ready":
      return args[0] ? cmdMarkReady(cwd, args.join(" "), configPath) : (usage(), 2);
    case "add-decision":
      return args.length ? cmdAddDecision(cwd, args, configPath) : (usage(), 2);
    case "queue":
      return cmdQueue(cwd, args, configPath);
    case "sweep": {
      const maxFlag = args.indexOf("--max");
      const maxRaw = maxFlag >= 0 ? Number(args[maxFlag + 1]) : NaN;
      const max = Number.isFinite(maxRaw) ? maxRaw : undefined;
      return cmdSweep(cwd, max, args.includes("--dry-run"), configPath);
    }
    case "intake-list":
      return cmdIntakeList(cwd, args.includes("--json"), configPath);
    case "intake-defer": {
      const title = args[0];
      const question = args.slice(1).join(" ");
      if (!title || !question) { usage(); return 2; }
      return cmdIntakeDefer(cwd, title, question, configPath);
    }
    case "seed-worktree":
      return args[0] ? cmdSeedWorktree(cwd, args[0], configPath) : (usage(), 2);
    case "spawn-worktree":
      return cmdSpawnWorktree(cwd, args, configPath);
    case "enqueue-findings":
      return args[0] ? cmdEnqueueFindings(cwd, args[0], configPath) : (usage(), 2);
    case "audit-plan":
      return args[0] ? cmdAuditPlan(cwd, args[0], configPath) : (usage(), 2);
    case "brief":
      return args[0] === "write" ? cmdBriefWrite(cwd, args.slice(1), configPath) : cmdBrief(cwd, args, configPath);
    case "run-to-goal":
      return cmdRunToGoal(cwd, args, configPath);
    case "reflect":
      return cmdReflect(cwd, args, configPath);
    case "audit":
      return cmdAudit(cwd, args, configPath);
    case "drain":
      return cmdDrain(cwd, args, configPath);
    case "fix":
      return cmdFix(cwd, args, configPath);
    case "build":
    case "design":
      return cmdBuild(cwd, args, configPath);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();
      return 0;
    default: {
      // Bare request → route to build or fix.
      const request = [sub, ...args].join(" ");
      const mode = await classifyMode(request, defaultClassifyModeDeps(cwd));
      console.log(`(routed to ${mode} mode)`);
      return mode === "build" ? cmdBuild(cwd, [request, ...(configPath ? ["--config", configPath] : [])], configPath) : cmdFix(cwd, [request], configPath);
    }
  }
}

if (import.meta.main) {
  main(process.argv.slice(2), process.cwd())
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
