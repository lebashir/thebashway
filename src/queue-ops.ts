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

/** Claim the first unclaimed item for this session/branch; null if none. */
export function claimNext(
  session: string,
  branch: string,
  queuePath: string,
): Promise<QueueItem | null> {
  return mutateQueue(queuePath, (items) => {
    const it = items.find((i) => i.status === "unclaimed");
    if (!it) return null;
    it.status = "claimed";
    it.claim = { session, branch };
    return { ...it };
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
