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

// ---------------------------------------------------------------------------
// Seam contracts
// ---------------------------------------------------------------------------

export interface BashaOutcome {
  ok: boolean;
  branch: string;
  reason?: string;
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

    if (!basha.ok) {
      const reason = basha.reason ?? "build failed";
      await markBlocked(item.title, reason, opts.queuePath);
      report.blocked.push({ item: item.title, reason });
      rec.deployResult = `blocked: ${reason}`;
      rec.anomalies.push("build failed");
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
          if (integ.misSlice) {
            await deps.appendLessonFn(
              `[integration] mis-sliced pair — re-intake: "${item.title}" conflicts on the integration branch with an already-merged unit (declared-disjoint territories overlapped at merge).`,
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
 * NOTE: the default git/worktree plumbing here (worktree-located verify, node_modules
 * symlink for tools worktrees, manifest sharing, integration-branch restore, the land
 * step) was exercised live and green on BOTH surfaces 2026-06-05 — two single-item
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
      // The tools surface is bun/pnpm-managed and NOT installed in the worktree (no
      // Turbopack), so symlink node_modules from the primary checkout — without it the
      // bun gate chain can't resolve deps. organs got a real install above (a symlink
      // is rejected by Turbopack). See lessons.md [worktree].
      if (!SURFACES[cfg.surface]?.needsRealInstall) {
        for (const rel of ["node_modules", "tools/node_modules"]) {
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
      if (!res.ok) return { ok: false, branch: ctx.branch, reason: res.timedOut ? "basha timed out" : "basha exited non-zero" };
      const done = parseMarker(res.stdout, "DONE");
      if (done !== null) return { ok: true, branch: ctx.branch };
      const blocked = parseMarker(res.stdout, "BLOCKED");
      return { ok: false, branch: ctx.branch, reason: blocked ?? "no DONE/BLOCKED marker" };
    },

    async verifyUnit(item, _branch, worktree) {
      // Run verify INSIDE the worktree's tools dir: the basha committed the unit's work
      // on the worktree's branch, and verify/index.ts derives repoRoot from
      // import.meta.dir → the worktree, so its HEAD is the unit tip (the primary
      // checkout's HEAD does NOT contain the unit's work). Read the manifest the run
      // wrote in the worktree, then tamper-recheck from the primary checkout (the head
      // SHA is a shared git object).
      const worktreeTools = resolve(worktree, "tools");
      const r = await bunRun(verifyArgs(cfg.baseRef, item.territory), { cwd: worktreeTools });
      if (r.code !== 0) return { ok: false, manifestHash: "-", reason: `verify exit ${r.code}` };
      const wtManifest = resolve(worktree, "tools", "orchestrator", ".verify-manifest.json");
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
      const r = await bunRun(verifyArgs(cfg.baseRef, unionTerritory), { cwd: resolve(cfg.repoRoot, "tools") });
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
  };
}
