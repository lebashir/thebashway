// tools/orchestrator/audit-run.ts
// The IN-door directed audit, codified into one command: resolveTarget → finder
// bashas (Opus, parallel, read-only) → adversarial verify (Opus) → shape (Opus, one
// per confirmed finding, consulting decisions.md) → enqueue-findings. Prints
// "queued N (M build-ready, K need input)". Mirrors drain.ts's design: the core
// (`runAudit`) is layer-clean with every LLM stage as an injected seam, so it is
// fully unit-testable without spawning claude; `defaultAuditDeps` wires the real
// runClaude calls (used by cli.ts, never executed in unit tests).
//
// This intentionally codifies the fan-out as a tested, injected-seam loop — relaxing
// the prior IN-door decision ("orchestration = driver + bashas, not committed code")
// now that headless.ts gives a tested spawn seam, consistent with drain.ts.
import {
  resolveTarget,
  effectiveQueueStatus,
  FindingSchema,
  CompletableItemSchema,
  type AuditPlan,
  type Finding,
  type CompletableItem,
} from "./audit";
import { enqueueFindings } from "./queue-ops";
import { buildIntakePromptFromDisk } from "./intake-prompt";
import { runClaude } from "./headless";
import { DESIGN_BAR } from "./design-bar";
import {
  AUDIT_FANOUT_MAX,
  AUDIT_BUILDREADY_MIN_CONFIDENCE,
  AUDIT_CONFIRM_MIN_CONFIDENCE,
  AUDIT_MAX_ENQUEUE,
  getDesignBar,
} from "./config";

export interface VerifiedFinding {
  finding: Finding;
  isReal: boolean;
  confidence: number;
}

export interface AuditDeps {
  /** One finder per sub-area (read-only Opus). Returns concrete findings ([] = clean). */
  runFinder(subArea: string, plan: AuditPlan): Promise<Finding[]>;
  /** Adversarial verify across ALL findings; refute by default if uncertain. */
  runVerify(findings: Finding[]): Promise<VerifiedFinding[]>;
  /** Shape one confirmed finding into a completable item (consulting decisions.md). */
  runShape(finding: Finding, confidence: number): Promise<CompletableItem | null>;
}

export interface AuditOptions {
  target: string;
  queuePath: string;
  repoRoot: string;
  decisionsPath: string;
  dryRun?: boolean;
  fanoutMax?: number;
  confirmMinConfidence?: number;
  buildReadyMinConfidence?: number;
  maxEnqueue?: number;
}

export interface AuditReport {
  plan: AuditPlan;
  findingCount: number;
  confirmedCount: number;
  shaped: CompletableItem[];
  droppedOverCap: number;
  downgradedLowConfidence: number;
  enqueued: { appended: number; skippedExisting: number; buildReady: number; needInput: number } | null;
}

export async function runAudit(opts: AuditOptions, deps: AuditDeps): Promise<AuditReport> {
  // Resolve the target FIRST — throws clearly on an unknown target (surfaced by CLI).
  const plan = resolveTarget(opts.target);
  const fanoutMax = opts.fanoutMax ?? AUDIT_FANOUT_MAX;
  const confirmMin = opts.confirmMinConfidence ?? AUDIT_CONFIRM_MIN_CONFIDENCE;
  const buildReadyMin = opts.buildReadyMinConfidence ?? AUDIT_BUILDREADY_MIN_CONFIDENCE;
  const maxEnqueue = opts.maxEnqueue ?? AUDIT_MAX_ENQUEUE;

  // 1. Finders — parallel, capped at fanoutMax. A finder that throws or yields a
  //    malformed finding never aborts the audit (drops to nothing for that sub-area).
  const subAreas = plan.subAreas.slice(0, fanoutMax);
  const findingArrays = await Promise.all(
    subAreas.map(async (sa) => {
      try {
        const raw = await deps.runFinder(sa, plan);
        return raw.filter((f) => FindingSchema.safeParse(f).success);
      } catch (e) {
        console.error(`audit: finder for "${sa}" failed: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    }),
  );
  const allFindings = findingArrays.flat();

  // 2. Adversarial verify — keep only is_real AND confidence >= the confirm bar.
  let verified: VerifiedFinding[] = [];
  if (allFindings.length > 0) {
    try {
      verified = await deps.runVerify(allFindings);
    } catch (e) {
      console.error(`audit: verify failed: ${e instanceof Error ? e.message : String(e)}`);
      verified = [];
    }
  }
  const confirmed = verified.filter((v) => v.isReal && v.confidence >= confirmMin);

  // Per-audit enqueue cap: keep the highest-confidence confirmed findings.
  const sorted = [...confirmed].sort((a, b) => b.confidence - a.confidence);
  const kept = sorted.slice(0, maxEnqueue);
  const droppedOverCap = sorted.length - kept.length;

  // 3. Shape — one per kept finding. Enforce the build-ready confidence floor:
  //    a confirmed-but-below-floor finding can only enter the queue as @needs-intake.
  let downgradedLowConfidence = 0;
  const shaped: CompletableItem[] = [];
  for (const v of kept) {
    let item: CompletableItem | null;
    try {
      item = await deps.runShape(v.finding, v.confidence);
    } catch (e) {
      console.error(`audit: shape failed for "${v.finding.title}": ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!item || !CompletableItemSchema.safeParse(item).success) continue;
    if (item.status === "unclaimed" && v.confidence < buildReadyMin) {
      item = { ...item, status: "needs-intake" };
      downgradedLowConfidence++;
    }
    // Deterministic design rail: a design-quality finding is taste — ALWAYS human-gated. Force it
    // @needs-intake off the SOURCE finding's kind (never trusting the shaper's freezeSafe), and
    // stamp the provenance. Mirrors how design-run.ts re-adds rails as tested code, not LLM prose.
    if (v.finding.kind === "design") {
      item = { ...item, kind: "design", status: "needs-intake" };
    }
    shaped.push(item);
  }

  // 4. Enqueue (unless dry-run). enqueueFindings owns the freeze-safe/open-question
  //    forcing + dedup; we only report from its authoritative result.
  let enqueued: AuditReport["enqueued"] = null;
  if (!opts.dryRun && shaped.length > 0) {
    const plan2 = await enqueueFindings(shaped, opts.queuePath);
    // Count from the authoritative DEDUPED appended list (each entry carries the item
    // fields + source) — never by re-intersecting shaped, which would double-count two
    // items sharing a fingerprint.
    const appended = plan2.appended as Array<CompletableItem & { source: string }>;
    const buildReady = appended.filter((i) => effectiveQueueStatus(i) === "unclaimed").length;
    enqueued = {
      appended: appended.length,
      skippedExisting: plan2.skippedExisting.length,
      buildReady,
      needInput: appended.length - buildReady,
    };
  }

  return {
    plan,
    findingCount: allFindings.length,
    confirmedCount: confirmed.length,
    shaped,
    droppedOverCap,
    downgradedLowConfidence,
    enqueued,
  };
}

// ---------------------------------------------------------------------------
// JSON extraction from headless output (pure — the fragile part, so it is tested)
// ---------------------------------------------------------------------------

/**
 * Every TOP-LEVEL balanced `[..]`/`{..}` span in `s` (string-aware, so brackets inside
 * quoted strings don't throw off the depth count). Nested brackets are NOT returned
 * separately — only the outermost spans — so a territory array inside a shaped object
 * doesn't compete with the object itself.
 */
function balancedSpans(s: string): string[] {
  const spans: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const open = s[i];
    if (open !== "[" && open !== "{") continue;
    const close = open === "[" ? "]" : "}";
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          spans.push(s.slice(i, j + 1));
          i = j; // skip past this whole span (don't re-scan its interior)
          break;
        }
      }
    }
  }
  return spans;
}

/**
 * Pull the JSON payload from headless output: the LAST ```json (or bare ```) fenced
 * block (what the default prompts mandate), else the LONGEST parseable top-level
 * balanced span. Longest-wins makes the fallback robust to stray brackets in prose
 * (e.g. "line [42]: [{...real array...}]" returns the real array, not [42]) and serves
 * both array callers (findings/verdicts) and the single-object caller (shaped).
 */
export function extractJsonBlock(stdout: string): string | null {
  const fences = [...stdout.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  if (fences.length) return fences[fences.length - 1][1].trim();
  let best: string | null = null;
  for (const span of balancedSpans(stdout)) {
    try {
      JSON.parse(span);
      if (!best || span.length > best.length) best = span;
    } catch {
      /* not valid JSON — skip */
    }
  }
  return best;
}

/** Parse + validate a finder's JSON-array output into Finding[]. Malformed → []. */
export function parseFindings(stdout: string, subArea: string): Finding[] {
  const block = extractJsonBlock(stdout);
  if (!block) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: Finding[] = [];
  for (const r of raw) {
    const withArea = { subArea, ...(r as object) }; // default subArea if the model omitted it
    const parsed = FindingSchema.safeParse(withArea);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Parse the verifier's index-aligned verdicts; default-refute anything missing/malformed. */
export function parseVerdicts(stdout: string, findings: Finding[]): VerifiedFinding[] {
  const refuteAll = (): VerifiedFinding[] => findings.map((f) => ({ finding: f, isReal: false, confidence: 0 }));
  const block = extractJsonBlock(stdout);
  if (!block) return refuteAll();
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    return refuteAll();
  }
  if (!Array.isArray(raw)) return refuteAll();
  const byIndex = new Map<number, { is_real: boolean; confidence: number }>();
  for (const r of raw) {
    if (r && typeof r === "object") {
      const o = r as Record<string, unknown>;
      const idx = typeof o.index === "number" ? o.index : NaN;
      if (Number.isInteger(idx)) {
        byIndex.set(idx, {
          is_real: o.is_real === true,
          confidence: typeof o.confidence === "number" ? o.confidence : 0,
        });
      }
    }
  }
  return findings.map((f, i) => {
    const v = byIndex.get(i);
    // Missing verdict → default-refute (adversarial default).
    return { finding: f, isReal: v?.is_real ?? false, confidence: v?.confidence ?? 0 };
  });
}

/** Parse + validate the shaper's single JSON object into a CompletableItem, or null. */
export function parseShaped(stdout: string): CompletableItem | null {
  const block = extractJsonBlock(stdout);
  if (!block) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch {
    return null;
  }
  const parsed = CompletableItemSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Default (real) deps — wired by cli.ts; NOT executed in unit tests.
// ---------------------------------------------------------------------------

export function defaultAuditDeps(cfg: {
  repoRoot: string;
  decisionsPath: string;
  surface: string;
  /** "correctness" (default) hunts logic defects; "design" hunts design-system deviations. */
  auditKind?: "correctness" | "design";
  /** The per-project north star path. Threaded into the SHAPER's intake prompt ONLY (prompt-
   * context — so the shaper can justify a finding against the north star and may itself choose
   * needs-intake + an openQuestion). NO new deterministic gate, and it MUST NEVER raise the
   * needs-intake count for design-kind findings (those are already parked at :131). */
  briefPath?: string;
  /** Optional loud-signal sink for an unparseable brief surfaced while shaping (the §3.1 single
   * signal). Absent/ok stay benign. */
  notify?: (text: string) => Promise<boolean> | void;
}): AuditDeps {
  const designMode = cfg.auditKind === "design";
  // The §3.1 loud signal is emitted at most ONCE per audit run even though runShape is called per
  // finding — a botched brief edit should warn once, not once-per-finding.
  let briefSignalEmitted = false;
  // NOTE: these audit dispatches build their prompts INLINE (runFinder/runVerify here, runShape via
  // buildIntakePromptFromDisk) — they never route through buildBashaPrompt, so the standing design
  // bar is structurally NEVER present in them. The ONLY design-bar injection is the deliberate one
  // in the design-mode finder below. (This is why no "finder omits the bar" suppression test is
  // needed: there is no default-on bar to suppress on this code path.)
  return {
    async runFinder(subArea, plan) {
      const prompt = designMode
        ? `You are a READ-ONLY design auditor. Study the USER-FACING UI source under this sub-area ` +
          `of the ${plan.surface} surface:\n  ${subArea}\n(inside the target area ${plan.rootGlob}).\n` +
          `Judge it against this design bar:\n${getDesignBar() ?? DESIGN_BAR}\n\n` +
          `Find concrete, SOURCE-GROUNDED design-quality defects: deviations from the project's ` +
          `design system (a hardcoded value where a token exists, off-scale spacing, generic or ` +
          `default typography, missing hover / empty / loading / error states, weak hierarchy, not ` +
          `using a primitive that fits) and generic AI-slop patterns. Cite the file + the exact ` +
          `problem. Do NOT invent findings: an empty array is correct for clean UI. Set ` +
          `freezeSafe=false (a design change touches UI) and "kind":"design" on EVERY finding.\n` +
          `Output ONLY a JSON array (no prose) of {"title","description","subArea":"${subArea}",` +
          `"confidence":0-1,"freezeSafe":false,"kind":"design"}, wrapped in a \`\`\`json fenced block.`
        : `You are a READ-ONLY code auditor. Examine ONLY the files under this sub-area ` +
          `of the ${plan.surface} surface:\n  ${subArea}\n(inside the target area ${plan.rootGlob}).\n` +
          `Find concrete CORRECTNESS defects only — real bugs, not style or speculation. ` +
          `For each, set freezeSafe true if the fix is logic/backend/maintenance, false if it would ` +
          `add NEW organ UI (frozen). Do NOT invent findings: an empty array is the correct answer ` +
          `for clean code.\nOutput ONLY a JSON array (no prose) of ` +
          `{"title","description","subArea":"${subArea}","confidence":0-1,"freezeSafe":bool}, ` +
          `wrapped in a \`\`\`json fenced block.`;
      const res = await runClaude({ prompt, cwd: cfg.repoRoot, model: "opus" });
      if (!res.ok) return [];
      return parseFindings(res.stdout, subArea);
    },

    async runVerify(findings) {
      const list = findings
        .map((f, i) => `${i}. [${f.subArea}] ${f.title} — ${f.description} (finder confidence ${f.confidence})`)
        .join("\n");
      const prompt = designMode
        ? // Taste reframed as conformance: "refute if uncertain" would nuke every subjective design
          // finding, so judge defensible deviations from the SYSTEM instead of personal preference.
          `You are verifying candidate DESIGN-QUALITY findings against a design system. For each, judge: ` +
          `is this a REAL, DEFENSIBLE deviation from the stated design system, or a genuine design defect ` +
          `a designer would fix? Confirm defensible, source-grounded deviations (do NOT reflexively refute ` +
          `taste — judge conformance to the system, not personal preference). Reject only vague, ` +
          `unfounded, or purely-subjective items.\n${list}\n\n` +
          `Output ONLY a JSON array aligned by index: ` +
          `[{"index":n,"is_real":bool,"confidence":0-1,"reason":"..."}], in a \`\`\`json fenced block.`
        : `You are an ADVERSARIAL verifier. For each candidate defect below, TRY TO REFUTE it. ` +
          `Default to is_real=false if you are uncertain or cannot confirm it from the code.\n${list}\n\n` +
        `Output ONLY a JSON array aligned by index: ` +
        `[{"index":n,"is_real":bool,"confidence":0-1,"reason":"..."}], in a \`\`\`json fenced block.`;
      const res = await runClaude({ prompt, cwd: cfg.repoRoot, model: "opus" });
      if (!res.ok) return findings.map((f) => ({ finding: f, isReal: false, confidence: 0 }));
      return parseVerdicts(res.stdout, findings);
    },

    async runShape(finding, confidence) {
      const taskBody =
        `Shape this CONFIRMED defect into a completable build item.\n` +
        `DEFECT: ${finding.title}\nDETAIL: ${finding.description}\nSUB-AREA: ${finding.subArea}\n` +
        `VERIFY CONFIDENCE: ${confidence}\nFREEZE-SAFE: ${finding.freezeSafe}\n\n` +
        `Produce a SUFFICIENT territory (the glob list the fix may touch — too narrow makes the ` +
        `item un-completable, which the OUT door's scope-diff will reject). Choose status ` +
        `"unclaimed" ONLY if the item is fully specified, freeze-safe, high-confidence, and has NO ` +
        `open question; otherwise "needs-intake" with an "openQuestion".\nOutput ONLY one JSON object ` +
        `{"title","goal","territory":[...],"doneWhen","status":"unclaimed"|"needs-intake","openQuestion"?,` +
        `"freezeSafe":bool} in a \`\`\`json fenced block.`;
      const prompt = await buildIntakePromptFromDisk({
        decisionsPath: cfg.decisionsPath,
        itemAreas: [cfg.surface],
        taskBody,
        briefPath: cfg.briefPath,
        onBriefStatus: (r) => {
          // §3.1 single loud signal: an unparseable brief surfaced while shaping is reported once.
          if (r.status === "unparseable" && !briefSignalEmitted) {
            briefSignalEmitted = true;
            const msg = `brief unparseable — north star not loaded for the audit shaper: ${r.errors.join("; ")}`;
            if (cfg.notify) void cfg.notify(msg);
            else console.error(`[audit] ${msg}`);
          }
        },
      });
      const res = await runClaude({ prompt, cwd: cfg.repoRoot, model: "opus" });
      if (!res.ok) return null;
      return parseShaped(res.stdout);
    },
  };
}
