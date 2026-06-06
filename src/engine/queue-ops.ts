// tools/orchestrator/queue-ops.ts
// Mutating operations over queue.md, each performed under withLock so concurrent
// sessions can't claim the same item or clobber each other's writes. The file's
// header (prose + any commented example) is preserved; only the live item region
// is rewritten.
import { withLock } from "./lock";
import { parseQueue, serializeItem, type QueueItem } from "./queue";
import { territoriesOverlap } from "./territory";

/** Everything before the first LIVE (non-commented) item line is the header. */
function splitHeader(md: string): string {
  const lines = md.split("\n");
  let inComment = false;
  let firstItem = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.includes("<!--")) inComment = true;
    if (!inComment && /^- \[[ x]\]/.test(l)) {
      firstItem = i;
      break;
    }
    if (l.includes("-->")) inComment = false;
  }
  return lines.slice(0, firstItem).join("\n").replace(/\n+$/, "");
}

function render(header: string, items: QueueItem[]): string {
  const body = items.map(serializeItem).join("\n");
  return body ? `${header}\n\n${body}` : `${header}\n`;
}

/** Read → parse → mutate-in-place → write, all under the queue lock. */
async function mutateQueue<T>(queuePath: string, fn: (items: QueueItem[]) => T): Promise<T> {
  return withLock(`${queuePath}.lock`, async () => {
    const md = await Bun.file(queuePath).text();
    const header = splitHeader(md);
    const items = parseQueue(md);
    const ret = fn(items);
    await Bun.write(queuePath, render(header, items));
    return ret;
  });
}

/**
 * An item is claim-able if it's @unclaimed AND every entry in its `DependsOn`
 * list points to an item that is @done (or absent — a missing dep doesn't
 * block). Items @parked-on:<id> are NOT claim-able (the dep is parked, the
 * dependent stays parked too).
 */
function isClaimable(item: QueueItem, byTitle: Map<string, QueueItem>): boolean {
  if (item.status !== "unclaimed") return false;
  if (!item.dependsOn?.length) return true;
  return item.dependsOn.every((dep) => {
    const parent = byTitle.get(dep);
    if (!parent) return true; // missing dep is a no-op (item-not-found)
    return parent.status === "done";
  });
}

/** Claim the first claim-able item for this session/branch; null if none. */
export function claimNext(
  session: string,
  branch: string,
  queuePath: string,
): Promise<QueueItem | null> {
  return mutateQueue(queuePath, (items) => {
    const byTitle = new Map(items.map((i) => [i.title, i]));
    const inFlight = items.filter((i) => i.status === "claimed").map((i) => i.territory);
    const it = items.find(
      (i) => isClaimable(i, byTitle) && !inFlight.some((t) => territoriesOverlap(i.territory, t)),
    );
    if (!it) return null;
    it.status = "claimed";
    it.claim = { session, branch };
    return { ...it };
  });
}

/**
 * Claim up to N claim-able items for this session at once (run mode). Each
 * gets the same session but a per-item branch name from `branchFor(item)`.
 * Returns the claimed items in queue order. Empty array if none claim-able.
 */
/**
 * An item belongs to a surface iff EVERY territory glob is under that surface's dir
 * (e.g. `organs/…` for surface `organs`). A drain runs one surface's build/verify
 * config, so it must only claim that surface's items — a mixed-surface queue would
 * otherwise build a tools item with the organs chain (or vice versa).
 */
function inSurface(item: QueueItem, surfaceDir: string): boolean {
  return item.territory.length > 0 && item.territory.every((t) => t.startsWith(`${surfaceDir}/`));
}

export function claimNextN(
  n: number,
  session: string,
  branchFor: (item: QueueItem) => string,
  queuePath: string,
  opts: { excludeAuto?: boolean; surfaceDir?: string; allowTitles?: Set<string> } = {},
): Promise<QueueItem[]> {
  return mutateQueue(queuePath, (items) => {
    const byTitle = new Map(items.map((i) => [i.title, i]));
    const inFlight = items.filter((i) => i.status === "claimed").map((i) => i.territory);
    const claimed: QueueItem[] = [];
    for (const it of items) {
      if (claimed.length >= n) break;
      if (!isClaimable(it, byTitle)) continue;
      // Allow-list: a feature-isolated drain (the design door) claims ONLY this run's
      // enqueued items, so a pre-existing build-ready item on the same surface is neither
      // claimed nor folded into the run's feature-atomic landing decision.
      if (opts.allowTitles && !opts.allowTitles.has(it.title)) continue;
      // Only claim items belonging to the drain's surface (territory under its dir).
      if (opts.surfaceDir && !inSurface(it, opts.surfaceDir)) continue;
      // The headless/scheduled guard (decisions.md): when excludeAuto is set, a
      // machine-captured (origin:auto) build-ready item is NOT claimed without an
      // explicit opt-in. Default (interactive) leaves it claimable — the human read
      // the audit report before draining.
      if (opts.excludeAuto && it.origin === "auto") continue;
      if (inFlight.some((t) => territoriesOverlap(it.territory, t))) continue;
      it.status = "claimed";
      it.claim = { session, branch: branchFor(it) };
      claimed.push({ ...it });
      inFlight.push(it.territory);
    }
    return claimed;
  });
}

/**
 * Read-only preview: which items `claimNextN` WOULD claim right now, without
 * mutating the queue or taking the lock. Mirrors the same claim guard (claim-able +
 * territory-disjoint + the excludeAuto rule) so a dry-run can't drift from the real
 * claim. Used by `drain --dry-run`.
 */
export async function previewClaimable(
  n: number,
  queuePath: string,
  opts: { excludeAuto?: boolean; surfaceDir?: string; allowTitles?: Set<string> } = {},
): Promise<QueueItem[]> {
  const items = parseQueue(await Bun.file(queuePath).text());
  const byTitle = new Map(items.map((i) => [i.title, i]));
  const inFlight = items.filter((i) => i.status === "claimed").map((i) => i.territory);
  const picked: QueueItem[] = [];
  for (const it of items) {
    if (picked.length >= n) break;
    if (!isClaimable(it, byTitle)) continue;
    if (opts.allowTitles && !opts.allowTitles.has(it.title)) continue;
    if (opts.surfaceDir && !inSurface(it, opts.surfaceDir)) continue;
    if (opts.excludeAuto && it.origin === "auto") continue;
    if (inFlight.some((t) => territoriesOverlap(it.territory, t))) continue;
    picked.push({ ...it });
    inFlight.push(it.territory);
  }
  return picked;
}

export function markBlocked(title: string, reason: string, queuePath: string): Promise<boolean> {
  return mutateQueue(queuePath, (items) => {
    const it = items.find((i) => i.title === title);
    if (!it) return false;
    it.status = "blocked";
    it.blockedReason = reason;
    return true;
  });
}

export function markDone(title: string, queuePath: string): Promise<boolean> {
  return mutateQueue(queuePath, (items) => {
    const it = items.find((i) => i.title === title);
    if (!it) return false;
    it.status = "done";
    return true;
  });
}

/** Promote a @needs-intake item to @unclaimed (build-ready) after intake. */
export function markReady(title: string, queuePath: string): Promise<boolean> {
  return mutateQueue(queuePath, (items) => {
    const it = items.find((i) => i.title === title);
    if (!it || it.status !== "needs-intake") return false;
    it.status = "unclaimed";
    return true;
  });
}

export function appendItem(item: QueueItem, queuePath: string): Promise<void> {
  return mutateQueue(queuePath, (items) => {
    items.push(item);
  });
}

/**
 * Capture a rough item as @needs-intake. `origin:"auto"` marks a basha
 * self-enqueue (greppable + bulk-prunable); omit it for a human capture.
 * `source` is an optional dedup fingerprint (a swept TODO carries one).
 * Goal/territory/done-when are left empty for intake to fill.
 */
export function appendCapture(
  cap: { title: string; goal?: string; origin?: "auto" | "human"; source?: string },
  queuePath: string,
): Promise<void> {
  return appendItem(captureToItem(cap), queuePath);
}

function captureToItem(cap: {
  title: string;
  goal?: string;
  origin?: "auto" | "human";
  source?: string;
}): QueueItem {
  return {
    title: cap.title,
    status: "needs-intake",
    origin: cap.origin === "auto" ? "auto" : undefined,
    source: cap.source,
    goal: cap.goal ?? "",
    territory: [],
    doneWhen: "",
    clarifications: [],
  };
}

export interface SweepCapture {
  title: string;
  goal?: string;
  source: string;
  origin?: "auto" | "human";
}

/** Partition of capture candidates by source-dedup + per-run cap. */
export interface DedupePlan<T> {
  /** New source, within budget — will be appended. */
  appended: T[];
  /** Skipped: a matching `source` is already present (any status). */
  skippedExisting: T[];
  /** Skipped: the per-run budget (`max`) was already spent. */
  skippedBudget: T[];
}

export type DedupedAppendResult = DedupePlan<SweepCapture>;

/**
 * Pure: partition `caps` into append / skip-existing / skip-budget by deduping
 * `source` against `existing` and honoring `max`. Mutates nothing (a local copy of
 * `existing` tracks within-batch dups) — the caller performs any side effects on
 * `appended`. Shared by the real append path and the sweep's dry-run preview so the
 * two can't drift.
 */
export function planDedupedCaptures<T extends { source: string }>(
  caps: T[],
  existing: Set<string>,
  max: number,
): DedupePlan<T> {
  const seen = new Set(existing);
  const plan: DedupePlan<T> = { appended: [], skippedExisting: [], skippedBudget: [] };
  for (const cap of caps) {
    if (seen.has(cap.source)) { plan.skippedExisting.push(cap); continue; }
    if (plan.appended.length >= max) { plan.skippedBudget.push(cap); continue; }
    seen.add(cap.source);
    plan.appended.push(cap);
  }
  return plan;
}

/**
 * Append machine-captured items as @needs-intake, deduped by `source` and capped
 * at `max`, all under ONE lock (read-existing + append are a single atomic op, so
 * two concurrent sweeps can't both append the same fingerprint).
 *
 * Dedup is against items of EVERY status — a `@done`/`@parked` item with a matching
 * `source` blocks re-enqueue (a swept TODO whose fix already shipped must not come
 * back just because the comment lingers in code). Within-batch duplicates collapse too.
 */
export function appendCapturesDeduped(
  caps: SweepCapture[],
  opts: { max: number },
  queuePath: string,
): Promise<DedupedAppendResult> {
  return mutateQueue(queuePath, (items) => {
    const existing = new Set(items.map((i) => i.source).filter(Boolean) as string[]);
    const plan = planDedupedCaptures(caps, existing, opts.max);
    for (const cap of plan.appended) {
      items.push(captureToItem({ ...cap, origin: cap.origin ?? "auto" }));
    }
    return plan;
  });
}

/**
 * The conservative auto-intake "defer" path: record a free-text open question on a
 * @needs-intake item and KEEP it @needs-intake (so a drain still can't claim it).
 * Stored in the dedicated `openQuestion` field — NOT a Clarification — because a
 * free-text question may contain " A:" which would corrupt the `- Q: ... A: ...`
 * round-trip. Returns false if the item is absent or not @needs-intake.
 */
export function recordOpenQuestion(
  title: string,
  question: string,
  queuePath: string,
): Promise<boolean> {
  return mutateQueue(queuePath, (items) => {
    const it = items.find((i) => i.title === title);
    if (!it || it.status !== "needs-intake") return false;
    it.openQuestion = question;
    return true;
  });
}

/**
 * Park an item — set status to `parked`, record the reason. Cascade: any item
 * whose `DependsOn` references this one and is currently @unclaimed flips to
 * `@parked-on:<title>`. Returns the list of titles affected (the parked item
 * + every cascaded dependent) for the digest emit.
 */
export function parkItem(
  title: string,
  reason: string,
  queuePath: string,
): Promise<string[]> {
  return mutateQueue(queuePath, (items) => {
    const target = items.find((i) => i.title === title);
    if (!target) return [];
    target.status = "parked";
    target.parkReason = reason;
    target.claim = undefined;
    const affected: string[] = [title];
    for (const other of items) {
      if (other === target) continue;
      if (other.status !== "unclaimed") continue;
      if (!other.dependsOn?.includes(title)) continue;
      other.status = "parked-on";
      other.parkedOn = title;
      affected.push(other.title);
    }
    return affected;
  });
}

// ---------------------------------------------------------------------------
// Directed-audit IN door: enqueueFindings
// ---------------------------------------------------------------------------

/**
 * Enqueue a batch of completable items from a directed audit, atomic under the
 * queue lock. Uses planDedupedCaptures for dedup/cap, keyed by the item's audit
 * fingerprint ("audit:<hash>"). Dedup is across ALL statuses so a re-audit of an
 * already-queued (or @done) area does not re-enqueue the same finding.
 *
 * Status rule:
 *   - freezeSafe:false   → always forced to @needs-intake (never auto-build-ready)
 *   - openQuestion set   → @needs-intake + Open-question recorded
 *   - high-confidence    → item's chosen status is honored (@unclaimed or @needs-intake)
 *
 * Every enqueued item is tagged origin:auto and carries the audit fingerprint as Source.
 */
export function enqueueFindings(
  items: import("./audit").CompletableItem[],
  queuePath: string,
  opts?: { freezeAuthorized?: boolean },
): Promise<DedupedAppendResult> {
  // Lazy import to avoid circular deps at module parse time (audit.ts imports capture-sweep).
  const { auditFingerprint, effectiveQueueStatus } = require("./audit") as typeof import("./audit");

  // Attach fingerprints before taking the lock (pure computation).
  const withFp = items.map((item) => ({
    item,
    source: auditFingerprint(item),
  }));

  return mutateQueue(queuePath, (queueItems) => {
    const existing = new Set(
      queueItems.map((i) => i.source).filter(Boolean) as string[],
    );
    const caps = withFp.map(({ item, source }) => ({ ...item, source }));
    const plan = planDedupedCaptures(caps, existing, Number.MAX_SAFE_INTEGER);

    for (const cap of plan.appended) {
      const { item, source } = withFp.find((w) => w.source === cap.source)!;
      // Determine the effective status (freeze-safe rule + open-question rule). A design
      // run passes freezeAuthorized so an explicitly-requested new-UI task is build-ready;
      // audit passes nothing (unchanged). The open-question branch — which the design
      // runner's irreversible / surface / dep-graph gates set — always wins.
      const effectiveStatus: import("./queue").QueueStatus = effectiveQueueStatus(item, {
        freezeAuthorized: opts?.freezeAuthorized,
      });

      const queued: import("./queue").QueueItem = {
        title: item.title,
        status: effectiveStatus,
        origin: "auto",
        source,
        goal: item.goal,
        territory: item.territory,
        doneWhen: item.doneWhen,
        clarifications: [],
      };
      if (item.openQuestion) queued.openQuestion = item.openQuestion;
      if (item.dependsOn?.length) queued.dependsOn = item.dependsOn;
      queueItems.push(queued);
    }
    return plan;
  });
}

/**
 * Scan for `parked-on` items whose parent is no longer `@parked` (e.g. Bashir
 * answered the question and flipped it back to `@unclaimed`). Flip them back
 * to `@unclaimed`. Returns the titles that were un-parked.
 */
export function unparkScan(queuePath: string): Promise<string[]> {
  return mutateQueue(queuePath, (items) => {
    const byTitle = new Map(items.map((i) => [i.title, i]));
    const unparked: string[] = [];
    for (const it of items) {
      if (it.status !== "parked-on") continue;
      const parent = it.parkedOn ? byTitle.get(it.parkedOn) : undefined;
      // Parent gone or no longer parked → release the dependent.
      if (!parent || parent.status !== "parked") {
        it.status = "unclaimed";
        it.parkedOn = undefined;
        unparked.push(it.title);
      }
    }
    return unparked;
  });
}
