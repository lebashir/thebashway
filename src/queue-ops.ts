// tools/orchestrator/queue-ops.ts
// Mutating operations over queue.md, each performed under withLock so concurrent
// sessions can't claim the same item or clobber each other's writes. The file's
// header (prose + any commented example) is preserved; only the live item region
// is rewritten.
import { withLock } from "./lock";
import { parseQueue, serializeItem, type QueueItem } from "./queue";

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
    const it = items.find((i) => isClaimable(i, byTitle));
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
export function claimNextN(
  n: number,
  session: string,
  branchFor: (item: QueueItem) => string,
  queuePath: string,
): Promise<QueueItem[]> {
  return mutateQueue(queuePath, (items) => {
    const byTitle = new Map(items.map((i) => [i.title, i]));
    const claimed: QueueItem[] = [];
    for (const it of items) {
      if (claimed.length >= n) break;
      if (!isClaimable(it, byTitle)) continue;
      it.status = "claimed";
      it.claim = { session, branch: branchFor(it) };
      claimed.push({ ...it });
    }
    return claimed;
  });
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

export function appendItem(item: QueueItem, queuePath: string): Promise<void> {
  return mutateQueue(queuePath, (items) => {
    items.push(item);
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
