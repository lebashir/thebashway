// tools/orchestrator/design-run.ts
// The feature-design IN door, codified into one command. Mirrors audit-run.ts: the core
// `runFeatureDesign` is layer-clean with every LLM/side-effecting stage an injected
// `DesignDeps` seam (fully unit-testable without spawning claude or running git);
// `defaultDesignDeps` wires the real runClaude calls + the chained drain (used by cli.ts,
// never executed in unit tests).
//
// Pipeline: DESIGN (Opus) → DECOMPOSE (Opus) → COLD-REVIEW design+tasks (Opus) →
// DETERMINISTIC GATES (design.ts) → enqueueFindings → FEATURE-ATOMIC staged drain → land.
// See docs/superpowers/specs/2026-06-05-thebashway-feature-design-door.md.
import {
  FeatureDesignSchema,
  DecompositionSchema,
  DesignReviewSchema,
  surfaceRoles,
  classifyIrreversible,
  validateSurface,
  validateDepGraph,
  findDuplicateTitleIndices,
  type FeatureDesign,
  type DesignReview,
} from "./design";
import type { CompletableItem } from "./audit";
import { effectiveQueueStatus } from "./audit";
import { enqueueFindings } from "./queue-ops";
import { buildIntakePromptFromDisk } from "./intake-prompt";
import { runClaude } from "./headless";
import { extractJsonBlock } from "./audit-run";
import { SURFACES, DESIGN_MAX_TASKS } from "./config";
import type { DrainReport } from "./drain";

// ---------------------------------------------------------------------------
// Seam contract
// ---------------------------------------------------------------------------

export interface DesignDeps {
  /** Design the feature + choose its natural home. null = could not design. */
  runDesign(description: string): Promise<FeatureDesign | null>;
  /** Decompose a design into completable tasks ([] = none / failed). */
  runDecompose(design: FeatureDesign): Promise<CompletableItem[]>;
  /** Cold-review the design AND the task list (fresh). null = no usable verdict. */
  runReview(description: string, design: FeatureDesign, tasks: CompletableItem[]): Promise<DesignReview | null>;
  /** Run the OUT-door drain STAGED (land disabled, no-op notify) for `surface`, claiming
   * up to `n` and ONLY items whose title is in `allowTitles` (feature isolation — a
   * pre-existing queue item is never built nor folded into the landing decision). Returns
   * the drain report (the runner decides landing — feature-atomic). */
  runDrainStaged(surface: string, n: number, allowTitles: string[]): Promise<DrainReport>;
  /** Land a staged integration branch → main + push (deploy). Reuses drain's land logic. */
  landIntegration(integrationBranch: string, landBranch: string): Promise<{ ok: boolean; reason?: string }>;
  /** Single combined Telegram (or any) digest. */
  notify(text: string): Promise<boolean>;
}

export interface DesignOptions {
  description: string;
  queuePath: string;
  repoRoot: string;
  decisionsPath: string;
  /** Override the inferred surface (rarely; the design picks it from roles). */
  surface?: string;
  dryRun?: boolean;
  noDrain?: boolean;
  /** Invocation-bound freeze authorization. Interactive CLI = true; scheduled = false. */
  freezeAuthorized?: boolean;
  maxTasks?: number;
}

export interface DesignReport {
  design: FeatureDesign | null;
  surface: string | null;
  tasks: CompletableItem[];
  gated: {
    irreversible: string[];
    surfaceMismatch: string[];
    danglingDep: string[];
    cyclicDep: string[];
    reviewFlagged: string[];
    /** Forced @needs-intake because a task it dependsOn was itself held (cascade). */
    dependsOnHeld: string[];
    /** Every task forced @needs-intake because the design was structurally rejected twice. */
    structuralRevise: string[];
    /** Forced @needs-intake because its title is not unique in the batch (queue identity). */
    duplicateTitle: string[];
  };
  enqueued: { appended: number; skippedExisting: number; buildReady: number; needInput: number } | null;
  drain: DrainReport | null;
  landed: boolean;
  landResult: string;
  summary: string;
  aborted?: string;
}

const EMPTY_GATED = (): DesignReport["gated"] => ({
  irreversible: [],
  surfaceMismatch: [],
  danglingDep: [],
  cyclicDep: [],
  reviewFlagged: [],
  dependsOnHeld: [],
  structuralRevise: [],
  duplicateTitle: [],
});

// ---------------------------------------------------------------------------
// The core (injected-seam, pure of real IO except the atomic enqueue + queue lock)
// ---------------------------------------------------------------------------

export async function runFeatureDesign(opts: DesignOptions, deps: DesignDeps): Promise<DesignReport> {
  const maxTasks = opts.maxTasks ?? DESIGN_MAX_TASKS;
  const freezeAuthorized = opts.freezeAuthorized ?? true;
  const base = (over: Partial<DesignReport>): DesignReport => ({
    design: null,
    surface: null,
    tasks: [],
    gated: EMPTY_GATED(),
    enqueued: null,
    drain: null,
    landed: false,
    landResult: "",
    summary: "",
    ...over,
  });

  // 1. Design.
  let design = await deps.runDesign(opts.description);
  if (!design) return base({ aborted: "could not design the feature", summary: "design failed" });
  let surface = opts.surface ?? design.surface;

  // 2. Decompose.
  let tasks = await deps.runDecompose(design);
  if (!tasks.length) return base({ design, surface, aborted: "decompose produced no tasks", summary: "decompose failed" });
  if (tasks.length > maxTasks) {
    return base({
      design,
      surface,
      aborted: `feature too large: ${tasks.length} tasks > DESIGN_MAX_TASKS ${maxTasks}; split it`,
      summary: `too large (${tasks.length} > ${maxTasks})`,
    });
  }

  // 3. Cold-review design + tasks; one bounce on a structural "revise".
  let review = await deps.runReview(opts.description, design, tasks);
  if (review?.designVerdict === "revise") {
    const feedback = `${opts.description}\n\nREVISION REQUIRED (a fresh review rejected the prior design): ${review.required.join("; ")}`;
    const design2 = await deps.runDesign(feedback);
    if (!design2) {
      // Re-design after a structural rejection FAILED — never build the rejected design.
      return base({ design, surface, aborted: "re-design after a structural review failed; not building the rejected design", summary: "re-design failed" });
    }
    design = design2;
    surface = opts.surface ?? design.surface;
    tasks = await deps.runDecompose(design);
    if (!tasks.length) return base({ design, surface, aborted: "decompose produced no tasks after revision", summary: "decompose failed" });
    if (tasks.length > maxTasks) {
      return base({ design, surface, aborted: `feature too large after revision: ${tasks.length} > ${maxTasks}`, summary: `too large (${tasks.length} > ${maxTasks})` });
    }
    review = await deps.runReview(opts.description, design, tasks);
  }
  // A design the fresh review STILL rejects structurally (after the one bounce) must never
  // auto-build — every task is forced @needs-intake below so a human reviews the contested
  // design rather than the loop building+deploying it.
  const structuralRevise = review?.designVerdict === "revise";

  // 4. Deterministic gates — finalize each task's status (force @needs-intake + record the
  //    reason as an Open-question). None of these can be overridden by LLM output.
  const surfaceBad = new Set(validateSurface(tasks, surface as "organs" | "tools"));
  const dupTitleSet = new Set(findDuplicateTitleIndices(tasks));
  const dep = validateDepGraph(tasks);
  const danglingSet = new Set(dep.dangling);
  const cyclicSet = new Set(dep.cyclic);
  const reviewBad = new Map<number, string>();
  for (const v of review?.taskVerdicts ?? []) {
    if (!v.buildReady) reviewBad.set(v.index, v.reason || "cold review flagged");
  }
  const gated = EMPTY_GATED();
  const structuralReason = structuralRevise
    ? `design structurally rejected by cold review: ${(review?.required ?? []).join("; ") || "structural concern"}`
    : null;

  tasks = tasks.map((t, i) => {
    const reasons: string[] = [];
    if (classifyIrreversible(t)) {
      reasons.push("reaches people / irreversible — confirm before building");
      gated.irreversible.push(t.title);
    }
    if (surfaceBad.has(i)) {
      reasons.push(`surface mismatch — territory not entirely under ${surface}/`);
      gated.surfaceMismatch.push(t.title);
    }
    if (dupTitleSet.has(i)) {
      reasons.push("duplicate task title — titles must be unique (queue identity)");
      gated.duplicateTitle.push(t.title);
    }
    if (danglingSet.has(i)) {
      reasons.push("depends on an unknown task — confirm ordering");
      gated.danglingDep.push(t.title);
    }
    if (cyclicSet.has(i)) {
      reasons.push("dependency cycle — confirm ordering");
      gated.cyclicDep.push(t.title);
    }
    if (reviewBad.has(i)) {
      reasons.push(`cold review: ${reviewBad.get(i)}`);
      gated.reviewFlagged.push(t.title);
    }
    if (structuralReason) {
      reasons.push(structuralReason);
      gated.structuralRevise.push(t.title);
    }
    if (!reasons.length) return t;
    const openQuestion = [t.openQuestion, ...reasons].filter(Boolean).join("; ");
    return { ...t, status: "needs-intake" as const, openQuestion };
  });

  // 4b. Cascade: a task that dependsOn a HELD task can never be claimed (isClaimable needs
  //     the parent @done), so it would strand silently and the feature could land half-built.
  //     Propagate @needs-intake to dependents of held tasks, to a fixpoint (handles chains).
  const isHeld = (t: CompletableItem): boolean => effectiveQueueStatus(t, { freezeAuthorized }) === "needs-intake";
  const heldTitles = new Set(tasks.filter(isHeld).map((t) => t.title));
  let cascaded = true;
  while (cascaded) {
    cascaded = false;
    tasks = tasks.map((t) => {
      if (isHeld(t)) return t;
      if ((t.dependsOn ?? []).some((d) => heldTitles.has(d))) {
        cascaded = true;
        heldTitles.add(t.title);
        gated.dependsOnHeld.push(t.title);
        const openQuestion = [t.openQuestion, "depends on a task held for your input"].filter(Boolean).join("; ");
        return { ...t, status: "needs-intake" as const, openQuestion };
      }
      return t;
    });
  }

  // 5. The feature's build-ready members (after ALL gates + the cascade) — the set that
  //    should build, the drain's allow-list (feature isolation), and the basis of the
  //    feature-atomic landing decision. Computed from `tasks`, not from the post-enqueue
  //    appended list, so a member that deduped against an already-queued item is still
  //    expected to build (and is claimed via the allow-list by its title).
  const buildReadyTitles = tasks
    .filter((t) => effectiveQueueStatus(t, { freezeAuthorized }) === "unclaimed")
    .map((t) => t.title);

  // Dry run: report what WOULD be enqueued, write nothing.
  if (opts.dryRun) {
    return base({
      design,
      surface,
      tasks,
      gated,
      enqueued: { appended: 0, skippedExisting: 0, buildReady: buildReadyTitles.length, needInput: tasks.length - buildReadyTitles.length },
      summary: `dry-run: would queue ${tasks.length} (${buildReadyTitles.length} build-ready)`,
    });
  }

  // 6. Enqueue (atomic, deduped). The freeze authorization is invocation-bound here.
  const plan = await enqueueFindings(tasks, opts.queuePath, { freezeAuthorized });
  const appended = plan.appended as Array<CompletableItem & { source: string }>;
  const appendedBuildReady = appended.filter((i) => effectiveQueueStatus(i, { freezeAuthorized }) === "unclaimed").length;
  const enqueued = {
    appended: appended.length,
    skippedExisting: plan.skippedExisting.length,
    buildReady: appendedBuildReady,
    needInput: appended.length - appendedBuildReady,
  };

  // 7. Stop here if not draining or nothing is build-ready.
  if (opts.noDrain || buildReadyTitles.length === 0) {
    const why = opts.noDrain ? "--no-drain" : "nothing build-ready (all need your input)";
    const summary = `design "${design.title}" — queued ${enqueued.appended} (${enqueued.buildReady} build-ready, ${enqueued.needInput} need input); not drained (${why})`;
    await deps.notify(summary);
    return base({ design, surface, tasks, gated, enqueued, summary });
  }

  // 8. Feature-atomic staged drain — claim ONLY this feature's build-ready members (the
  //    allow-list), so a pre-existing queue item is neither built nor folded into landing.
  //    Land is disabled inside drain (no-op notify there); the runner lands feature-atomically.
  const drain = await deps.runDrainStaged(surface, Math.min(buildReadyTitles.length, maxTasks), buildReadyTitles);

  // 9. Feature-atomic landing (+ organs-stage-not-deploy). Land ONLY if EVERY build-ready
  //    feature member reached @done — a member @blocked OR stranded (never claimed) → stage,
  //    never ship a half-built feature — AND the breaker did not trip AND the surface is not
  //    organs (a new organs route smoke can't exercise → stage for your review). Else stage.
  const built = new Set(drain.succeeded);
  const notBuilt = buildReadyTitles.filter((t) => !built.has(t));
  const stageOnly = !!SURFACES[surface]?.stageNotDeploy;
  const canLand = notBuilt.length === 0 && !drain.breakerTripped && !stageOnly;

  let landed = false;
  let landResult: string;
  if (canLand) {
    const res = await deps.landIntegration(drain.integrationBranch, "main");
    landed = res.ok;
    landResult = res.ok
      ? `landed ${drain.integrationBranch} → main + pushed (deployed)`
      : `LAND FAILED (safe at ${drain.integrationBranch}): ${res.reason ?? "unknown"}`;
  } else {
    const reason = stageOnly
      ? "this surface stages for review (a smoke test cannot exercise a new route)"
      : notBuilt.length > 0
        ? `${notBuilt.length} of ${buildReadyTitles.length} member(s) not built (${drain.blocked.length} blocked) — staged, not deployed (no half-built feature)`
        : drain.breakerTripped
          ? "breaker tripped — staged"
          : "staged";
    landResult = `staged at ${drain.integrationBranch} (${reason})`;
  }

  const verb = landed ? "deployed" : "built + staged for review";
  const summary = `design "${design.title}" — queued ${enqueued.appended} (${buildReadyTitles.length} build-ready); built ${drain.succeeded.length}, blocked ${drain.blocked.length}; ${verb}`;
  await deps.notify(summary);

  return base({ design, surface, tasks, gated, enqueued, drain, landed, landResult, summary });
}

// ---------------------------------------------------------------------------
// Parse helpers (the fragile LLM-output boundary — pure, tested)
// ---------------------------------------------------------------------------

export function parseFeatureDesign(stdout: string): FeatureDesign | null {
  const block = extractJsonBlock(stdout);
  if (!block) return null;
  try {
    const parsed = FeatureDesignSchema.safeParse(JSON.parse(block));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parseDecomposition(stdout: string): CompletableItem[] {
  const block = extractJsonBlock(stdout);
  if (!block) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const parsed = DecompositionSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Salvage the valid items if the array is partially malformed (never corrupt the queue).
  const out: CompletableItem[] = [];
  for (const r of raw) {
    const one = (DecompositionSchema.element as typeof DecompositionSchema.element).safeParse(r);
    if (one.success) out.push(one.data);
  }
  return out;
}

export function parseDesignReview(stdout: string): DesignReview | null {
  const block = extractJsonBlock(stdout);
  if (!block) return null;
  try {
    const parsed = DesignReviewSchema.safeParse(JSON.parse(block));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Default (real) deps — wired by cli.ts; NOT executed in unit tests.
// ---------------------------------------------------------------------------

/**
 * The real LLM stages (Opus) + the injected chain closures. cli.ts owns the drain/git
 * plumbing (it already builds the same deps for `cmdDrain`) and passes `runDrainStaged` +
 * `landIntegration` + `notify` in, so this file stays free of preflight/seed/git imports.
 *
 * NOTE: the chained-drain wiring is the same lightly-proven default-drain path drain.ts
 * itself flags — the injected-seam core (`runFeatureDesign`) is fully unit-tested; the
 * live `claude -p` + git chain is not yet exercised end-to-end on a multi-task feature.
 */
export function defaultDesignDeps(cfg: {
  repoRoot: string;
  decisionsPath: string;
  notify: (text: string) => Promise<boolean>;
  runDrainStaged: (surface: string, n: number, allowTitles: string[]) => Promise<DrainReport>;
  landIntegration: (integrationBranch: string, landBranch: string) => Promise<{ ok: boolean; reason?: string }>;
}): DesignDeps {
  const roles = surfaceRoles();

  return {
    async runDesign(description) {
      const taskBody =
        `You are a senior engineer DESIGNING a feature for the lifeofbash substrate. Design it ` +
        `for what it IS, then choose its NATURAL home from these surface ROLES — NEVER default to ` +
        `organs:\n${roles}\n\nRead the repo to ground the design in what already exists and where new ` +
        `code belongs.\nFEATURE REQUEST: "${description}"\n\n` +
        `Output ONLY one JSON object in a \`\`\`json block:\n` +
        `{"surface":"organs"|"tools","surfaceRationale":"...","title":"...","summary":"...","openQuestions":[...]}\n` +
        `- surface: choose "organs" ONLY if the feature is intrinsically a web-hub UI VIEW the user ` +
        `explicitly wants online; otherwise "tools". Ambiguous → "tools".\n` +
        `- openQuestions: ONLY genuine ambiguities a human must resolve; resolve everything else from ` +
        `the code + the decision defaults. Empty is the goal.`;
      const prompt = await buildIntakePromptFromDisk({ decisionsPath: cfg.decisionsPath, itemAreas: ["tools", "organs"], taskBody });
      const res = await runClaude({ prompt, cwd: cfg.repoRoot, model: "opus" });
      return res.ok ? parseFeatureDesign(res.stdout) : null;
    },

    async runDecompose(design) {
      const dir = SURFACES[design.surface]?.dir ?? design.surface;
      const taskBody =
        `Decompose this DESIGNED feature into COMPLETABLE build tasks for the autonomous OUT door.\n` +
        `DESIGN: ${JSON.stringify(design)}\n\nSURFACE ROLES:\n${roles}\n\n` +
        `Emit ONLY a JSON array (\`\`\`json) of items:\n` +
        `{"title","goal","territory":[globs],"doneWhen","status":"unclaimed"|"needs-intake",` +
        `"dependsOn"?:[exact sibling titles],"openQuestion"?,"freezeSafe":bool,"reachesPeople":bool,"destructive":bool}\n` +
        `RULES:\n` +
        `- Disjoint territories so independent tasks parallelize; dependsOn (by EXACT sibling title) ` +
        `orders chains (a migration before the code that reads it).\n` +
        `- territory must be SUFFICIENT (too narrow → scope-diff rejects). A NEW top-level organ task ` +
        `MUST include organs/src/registry.ts in its territory (required-touches).\n` +
        `- EVERY territory glob MUST be under "${dir}/". Do NOT span surfaces (one run = one surface).\n` +
        `- freezeSafe:false ONLY if the task adds NEW organs UI.\n` +
        `- reachesPeople:true if it sends to / messages / notifies a real person; destructive:true if it ` +
        `deletes/destroys unrecoverable data. Be honest — these force a human gate, never auto-built.\n` +
        `- status:"needs-intake"+openQuestion for anything not fully specified; "unclaimed" only when fully ` +
        `specified.\n- At most ${DESIGN_MAX_TASKS} tasks; if it needs more it is too large.`;
      const prompt = await buildIntakePromptFromDisk({ decisionsPath: cfg.decisionsPath, itemAreas: [design.surface], taskBody });
      const res = await runClaude({ prompt, cwd: cfg.repoRoot, model: "opus" });
      return res.ok ? parseDecomposition(res.stdout) : [];
    },

    async runReview(description, design, tasks) {
      const indexed = tasks.map((t, i) => `${i}. ${t.title} — ${t.goal} [${t.territory.join(", ")}] (status ${t.status})`).join("\n");
      const prompt =
        `You are a FRESH cold reviewer with ZERO prior context, reviewing a feature design AND its ` +
        `decomposition BEFORE an autonomous build + deploy. Be adversarial; default to NOT build-ready ` +
        `when uncertain.\nFEATURE REQUEST: "${description}"\nDESIGN: ${JSON.stringify(design)}\nTASKS:\n${indexed}\n\n` +
        `Judge: is the surface right (does each task's territory match the design surface)? is the ` +
        `decomposition complete and correctly ORDERED (dependsOn)? is anything over-decomposed or ` +
        `irrelevant to the request? is it lean? could any task reach a person or destroy data and be ` +
        `mis-flagged?\nOutput ONLY one JSON object (\`\`\`json):\n` +
        `{"designVerdict":"approve"|"revise","required":[...],"taskVerdicts":[{"index":n,"buildReady":bool,"reason":"..."}]}\n` +
        `- designVerdict "revise" ONLY for a structural flaw (wrong surface, missing core piece).\n` +
        `- taskVerdicts: one per task by index; buildReady:false for any task that is unsafe, mis-scoped, ` +
        `over-reaching, or that you cannot confirm belongs to the requested feature.`;
      const res = await runClaude({ prompt, cwd: cfg.repoRoot, model: "opus" });
      return res.ok ? parseDesignReview(res.stdout) : null;
    },

    runDrainStaged: cfg.runDrainStaged,
    landIntegration: cfg.landIntegration,
    notify: cfg.notify,
  };
}
