// tools/orchestrator/capture-sweep.ts
// Stage 2 capture sweep: scan the codebase for deliberately-flagged markers (the
// (tbw) opt-in form of TODO / FIXME) and turn each into a @needs-intake / origin:auto
// queue item — deduped by a line-shift-stable fingerprint and capped per run. The
// @needs-intake gate means a swept item can never self-build; intake (or Bashir)
// promotes it. See docs/superpowers/plans/2026-06-04-thebashway-stage2-auto-capture.md.
//
// scanForTodos / dedupeBySource / fingerprint are PURE (no fs) so the edge cases are
// unit-tested directly; gatherSignals / runSweep wrap them with the fs walk + queue write.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { appendCapturesDeduped, planDedupedCaptures, type SweepCapture, type DedupedAppendResult } from "./queue-ops";
import { parseQueue } from "./queue";
import { SWEEP } from "./config";

export interface CaptureCandidate extends SweepCapture {
  title: string;
  goal: string;
  source: string;
  origin: "auto";
}

export interface SweepConfig {
  scanGlobs: readonly string[];
  excludeGlobs: readonly string[];
  markerRegex: RegExp;
  wrapUpGlobs: readonly string[];
  wrapUpSignal: RegExp;
  maxPerSweep: number;
  backlogWarnAt: number;
}

const TITLE_MAX = 70;

/** Strip trailing comment-close tokens, collapse whitespace, lowercase. The
 * fingerprint is built from this so line moves + spacing/comment-prefix variation
 * do NOT re-enqueue; only a genuine wording edit does (accepted: reworded = new work). */
export function normalizeMarkerText(text: string): string {
  return text
    .replace(/\s*(?:\*\/|-->)\s*$/, "") // block / html comment closers
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function fingerprint(relpath: string, text: string): string {
  const h = createHash("sha1").update(normalizeMarkerText(text)).digest("hex").slice(0, 8);
  return `todo:${relpath}:${h}`;
}

function titleFrom(text: string): string {
  const t = text.replace(/\s*(?:\*\/|-->)\s*$/, "").trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1).trimEnd()}…` : t;
}

/**
 * Pure: scan in-memory files for the flagged marker. One candidate per matching line.
 * The line number rides in the goal (human breadcrumb) but NOT the fingerprint, so the
 * same marker moving down a file is still deduped.
 */
export function scanForTodos(
  files: { path: string; text: string }[],
  markerRegex: RegExp,
): CaptureCandidate[] {
  const out: CaptureCandidate[] = [];
  for (const f of files) {
    const lines = f.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i]!.match(markerRegex); // i < lines.length
      const captured = m?.[1]?.trim();
      if (!captured) continue;
      out.push({
        title: titleFrom(captured),
        goal: `From ${f.path}:${i + 1} — ${captured.replace(/\s*(?:\*\/|-->)\s*$/, "").trim()}`,
        source: fingerprint(f.path, captured),
        origin: "auto",
      });
    }
  }
  return out;
}

/** Pure: collapse within-batch duplicate fingerprints, keeping the first occurrence. */
export function dedupeBySource(cands: CaptureCandidate[]): CaptureCandidate[] {
  const seen = new Set<string>();
  const out: CaptureCandidate[] = [];
  for (const c of cands) {
    if (seen.has(c.source)) continue;
    seen.add(c.source);
    out.push(c);
  }
  return out;
}

/** True if `relpath` matches any exclude glob (post-scan reject — Glob has no ignore). */
export function isExcluded(relpath: string, excludeGlobs: readonly string[]): boolean {
  return excludeGlobs.some((g) => new Bun.Glob(g).match(relpath));
}

/**
 * Pure: harvest engineering-flavored bullets from wrap-up-audit candidate files.
 * Only `- ` bullets matching `signal` (a concrete defect/work keyword) become
 * candidates — life/behavioral bullets and the extractor's regex artifacts are left
 * for the operating-lessons path. The `wrapup:<relpath>:<hash>` fingerprint dedups the
 * heavy cross-session duplication those files carry.
 */
export function scanForWrapUpCandidates(
  files: { path: string; text: string }[],
  signal: RegExp,
): CaptureCandidate[] {
  const out: CaptureCandidate[] = [];
  for (const f of files) {
    const lines = f.text.split("\n");
    // Skip a leading YAML frontmatter block so a list-style sequence item (`- foo`)
    // in frontmatter is never mistaken for a candidate bullet.
    let inFrontmatter = lines[0]?.trim() === "---";
    for (let i = 0; i < lines.length; i++) {
      if (inFrontmatter) {
        if (i > 0 && lines[i]!.trim() === "---") inFrontmatter = false; // i < lines.length
        continue;
      }
      const text = lines[i]!.match(/^\s*-\s+(.*\S)\s*$/)?.[1]; // i < lines.length
      if (!text || !signal.test(text)) continue;
      const h = createHash("sha1").update(normalizeMarkerText(text)).digest("hex").slice(0, 8);
      out.push({
        title: titleFrom(text),
        goal: `From ${f.path} (wrap-up candidate) — ${text.trim()}`,
        source: `wrapup:${f.path}:${h}`,
        origin: "auto",
      });
    }
  }
  return out;
}

/** Walk `globs` (minus excludes) under repoRoot and read each file. Relpaths are
 * repo-relative so fingerprints are stable across machines. */
async function readGlobFiles(
  repoRoot: string,
  globs: readonly string[],
  excludeGlobs: readonly string[],
): Promise<{ path: string; text: string }[]> {
  const relpaths = new Set<string>();
  for (const glob of globs) {
    for await (const rel of new Bun.Glob(glob).scan({ cwd: repoRoot, onlyFiles: true })) {
      if (!isExcluded(rel, excludeGlobs)) relpaths.add(rel);
    }
  }
  const files: { path: string; text: string }[] = [];
  for (const rel of relpaths) {
    files.push({ path: rel, text: await Bun.file(resolve(repoRoot, rel)).text() });
  }
  return files;
}

/** fs-backed: gather TODO(tbw) markers + engineering wrap-up bullets, then dedupe. */
export async function gatherSignals(opts: {
  repoRoot: string;
  config?: SweepConfig;
}): Promise<CaptureCandidate[]> {
  const cfg = opts.config ?? SWEEP;
  const todoFiles = await readGlobFiles(opts.repoRoot, cfg.scanGlobs, cfg.excludeGlobs);
  const wrapFiles = await readGlobFiles(opts.repoRoot, cfg.wrapUpGlobs, cfg.excludeGlobs);
  const candidates = [
    ...scanForTodos(todoFiles, cfg.markerRegex),
    ...scanForWrapUpCandidates(wrapFiles, cfg.wrapUpSignal),
  ];
  return dedupeBySource(candidates);
}

export interface SweepResult extends DedupedAppendResult {
  candidates: CaptureCandidate[];
  dryRun: boolean;
  /** Count of @needs-intake items after the sweep, and whether it crossed the warn line. */
  backlog: number;
  backlogWarn: boolean;
}

/** Full sweep: gather → dedup-append (capped) → backlog check. `dryRun` skips the write. */
export async function runSweep(opts: {
  repoRoot: string;
  queuePath: string;
  config?: SweepConfig;
  dryRun?: boolean;
}): Promise<SweepResult> {
  const cfg = opts.config ?? SWEEP;
  const candidates = await gatherSignals({ repoRoot: opts.repoRoot, config: cfg });
  const dryRun = opts.dryRun ?? false;

  let res: DedupedAppendResult;
  if (!dryRun) {
    res = await appendCapturesDeduped(candidates, { max: cfg.maxPerSweep }, opts.queuePath);
  } else {
    // Dry run: classify what WOULD append via the same predicate, without writing.
    const items = parseQueue(await Bun.file(opts.queuePath).text());
    const existing = new Set(items.map((i) => i.source).filter(Boolean) as string[]);
    res = planDedupedCaptures(candidates, existing, cfg.maxPerSweep);
  }

  const after = parseQueue(await Bun.file(opts.queuePath).text());
  const backlog = after.filter((i) => i.status === "needs-intake").length;
  return { ...res, candidates, dryRun, backlog, backlogWarn: backlog > cfg.backlogWarnAt };
}
