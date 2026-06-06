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
//   check-sync               report drift vs the lifeofbash engine

import { resolve, join, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { setBinding } from "./engine/config";
import { noopSinks, type Notify } from "./sinks";
import type { ProjectBinding, ResolvedBinding } from "./binding";
import { classifyMode, defaultClassifyModeDeps } from "./router";
import { runInit, initMessage } from "./init";
import { checkSync, readSyncRef } from "./check-sync";
import { resolveTarget, effectiveQueueStatus } from "./engine/audit";
import { drain, defaultDrainDeps, type DrainDeps } from "./engine/drain";
import { runAudit, defaultAuditDeps } from "./engine/audit-run";
import { runFeatureDesign, defaultDesignDeps } from "./engine/design-run";
import { gitHead } from "./engine/verify/run";

// ---------------------------------------------------------------------------
// Binding loading + path derivation (pure-ish, unit-tested)
// ---------------------------------------------------------------------------

export interface DerivedPaths {
  repoRoot: string;
  queuePath: string;
  runLogPath: string;
  lessonsPath: string;
  decisionsPath: string;
  globalLessons: string | null;
}

export function derivePaths(binding: ProjectBinding): DerivedPaths {
  const root = binding.repoRoot;
  const rel = (p: string) => (isAbsolute(p) ? p : join(root, p));
  return {
    repoRoot: root,
    queuePath: join(root, ".thebashway", "queue.md"),
    runLogPath: join(root, ".thebashway", "run-log.md"),
    lessonsPath: rel(binding.learning.local),
    decisionsPath: rel(binding.learning.decisions),
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
  const r = await runInit(cwd, { globalLessons });
  console.log(initMessage(r));
  return r.prereqs.git ? 0 : 1;
}

function cmdCheckSync(): number {
  const refPath = new URL("../.sync-ref", import.meta.url).pathname;
  const ref = readSyncRef(refPath);
  if (!ref) {
    console.log("check-sync: no .sync-ref recorded — cannot compute drift.");
    return 0;
  }
  const report = checkSync({ sinceRef: ref });
  if (report.inSync) {
    console.log(`In sync with lifeofbash tools/orchestrator @ ${ref} (no new commits).`);
  } else {
    console.log(`DRIFT: ${report.commits.length} commit(s) to tools/orchestrator since ${ref}:`);
    for (const c of report.commits) console.log(`  ${c}`);
  }
  return 0;
}

async function cmdAuditPlan(cwd: string, target: string, configPath?: string): Promise<number> {
  await loadBinding({ cwd, configPath });
  console.log(JSON.stringify(resolveTarget(target), null, 2));
  return 0;
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
  });
}

/** FIX MODE: audit a target → enqueue findings → drain (build them). */
async function cmdFix(cwd: string, args: string[], configPath?: string): Promise<number> {
  const target = args.find((a) => !a.startsWith("--")) ?? ".";
  const dryRun = args.includes("--dry-run");
  const land = !args.includes("--no-land");
  const lb = await loadBinding({ cwd, configPath });
  tlsGuard();

  const plan = resolveTarget(target);
  const auditDeps = defaultAuditDeps({ repoRoot: lb.paths.repoRoot, decisionsPath: lb.paths.decisionsPath, surface: plan.surface });
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
  const lb = await loadBinding({ cwd, configPath });
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
  });

  const report = await runFeatureDesign(
    { description, queuePath: lb.paths.queuePath, repoRoot: lb.paths.repoRoot, decisionsPath: lb.paths.decisionsPath, dryRun, noDrain },
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

function usage(): void {
  console.log(`thebashway — autonomous Build + Fix for your repo

  thebashway init [--global <path>]      scaffold thebashway.config.ts + .thebashway/ store
  thebashway fix <target> [--dry-run] [--no-land]
                                         FIX: audit a file/dir/registry target, build the findings
  thebashway build "<feature>" [--dry-run] [--no-drain]
                                         BUILD: design a new feature, then build it
  thebashway "<request>"                 auto-route to build or fix
  thebashway audit-plan <target>         print the resolved plan (no model calls)
  thebashway check-sync                  report drift vs the lifeofbash engine

  Common: --config <path>  use a binding other than ./thebashway.config.ts
  Safety: tasks that reach people or destroy data are set aside for your approval.`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function main(argv: string[], cwd: string): Promise<number> {
  const [sub, ...rest] = argv;
  const cfgIdx = rest.indexOf("--config");
  const configPath = cfgIdx >= 0 ? rest[cfgIdx + 1] : undefined;
  const args = cfgIdx >= 0 ? rest.filter((_, i) => i !== cfgIdx && i !== cfgIdx + 1) : rest;

  switch (sub) {
    case "init":
      return cmdInit(cwd, args);
    case "check-sync":
      return cmdCheckSync();
    case "audit-plan":
      return args[0] ? cmdAuditPlan(cwd, args[0], configPath) : (usage(), 2);
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
