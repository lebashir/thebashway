// src/park.ts
// Park-and-continue emitter. When build hits a question only the human can
// answer (the bar is high — see SKILL.md "Park-and-continue mechanics"), the
// driver calls `emitPark()` which broadcasts to ALL surfaces the human might
// see, then keeps going on the next claim-able item.
//
// Surfaces:
//   - queue.md       (source of truth — `@parked (reason)` status; parkItem)
//   - NOW.md         (always-on attention surface — `## Parked` section)
//   - external sink  (optional callback — projects wire their own; lifeofbash
//                     inserts into `agent_events` so the organs AgentFeed
//                     surfaces it at lifeofbash.vercel.app)
//
// The corresponding `emitUnpark()` flips dependents back to `@unclaimed` (via
// unparkScan) and removes the NOW.md line + emits a follow-up external event.
import { parkItem, unparkScan } from "./queue-ops";

export interface ParkEvent {
  item: string;
  reason: string;
  /** Affected dependent items (set by parkItem); informational. */
  cascade: string[];
}

export interface ParkSurfaces {
  queuePath: string;
  /** Path to NOW.md (or equivalent always-on attention surface). */
  nowPath: string;
  /** Optional external sink (e.g. agent_events insert). Best-effort; errors logged but don't abort. */
  emitExternal?: (event: ParkEvent, kind: "parked" | "unparked") => Promise<void>;
}

const NOW_SECTION_HEADER = "## Parked — needs your call";

/** Insert / refresh the `## Parked` section in NOW.md with the given item lines. */
async function syncNowParkedSection(
  nowPath: string,
  lines: string[], // each: `- <title> — <reason>`
): Promise<void> {
  const f = Bun.file(nowPath);
  const existing = (await f.exists()) ? await f.text() : "";
  const all = existing.split("\n");
  const headerIdx = all.findIndex((l) => l.trim() === NOW_SECTION_HEADER);
  // Build the section block (header + lines + trailing blank line).
  const block = lines.length
    ? [NOW_SECTION_HEADER, "", ...lines, ""].join("\n")
    : "";
  if (headerIdx === -1) {
    // Insert just after frontmatter (---...---) if present, else at top.
    let insertAt = 0;
    if (all[0] === "---") {
      const close = all.indexOf("---", 1);
      if (close > 0) insertAt = close + 1;
    }
    const before = all.slice(0, insertAt).join("\n");
    const after = all.slice(insertAt).join("\n");
    const sep = before.length && !before.endsWith("\n") ? "\n" : "";
    const merged = block
      ? `${before}${sep}\n${block}\n${after}`
      : `${before}${sep}${after}`;
    await Bun.write(nowPath, merged);
    return;
  }
  // Replace the existing section (header → next `##` or EOF).
  let endIdx = all.length;
  for (let i = headerIdx + 1; i < all.length; i++) {
    if (/^##\s+/.test(all[i])) { endIdx = i; break; }
  }
  const before = all.slice(0, headerIdx).join("\n");
  const after = all.slice(endIdx).join("\n");
  // Drop trailing blank line on `before` to avoid stacking blanks.
  const beforeTrim = before.replace(/\n+$/, "");
  const merged = block
    ? `${beforeTrim}\n\n${block}\n${after}`
    : `${beforeTrim}\n\n${after}`;
  await Bun.write(nowPath, merged);
}

/** Rebuild the NOW.md `## Parked` section from the live queue. */
async function refreshNowFromQueue(
  queuePath: string,
  nowPath: string,
): Promise<void> {
  const { parseQueue } = await import("./queue");
  const md = await Bun.file(queuePath).text();
  const items = parseQueue(md);
  const lines = items
    .filter((i) => i.status === "parked")
    .map((i) => `- ${i.title} — ${i.parkReason ?? "(no reason given)"}`);
  await syncNowParkedSection(nowPath, lines);
}

/**
 * Park an item across all surfaces. Returns the ParkEvent for digest emit.
 * - queue.md      → @parked (reason) + cascade to @parked-on:<title>
 * - NOW.md        → refresh the `## Parked` section
 * - emitExternal  → fire (best-effort)
 */
export async function emitPark(
  title: string,
  reason: string,
  surfaces: ParkSurfaces,
): Promise<ParkEvent> {
  const affected = await parkItem(title, reason, surfaces.queuePath);
  const event: ParkEvent = { item: title, reason, cascade: affected.filter((t) => t !== title) };
  await refreshNowFromQueue(surfaces.queuePath, surfaces.nowPath);
  if (surfaces.emitExternal) {
    try {
      await surfaces.emitExternal(event, "parked");
    } catch (err) {
      console.error(`[park] external emit failed for "${title}":`, err);
    }
  }
  return event;
}

/**
 * Sweep parked-on dependents whose parents are no longer parked (e.g. Bashir
 * answered the question in queue.md and flipped status to @unclaimed).
 * Returns the list of unparked titles for digest emit.
 */
export async function emitUnparkScan(surfaces: ParkSurfaces): Promise<string[]> {
  const unparked = await unparkScan(surfaces.queuePath);
  if (unparked.length === 0) return unparked;
  await refreshNowFromQueue(surfaces.queuePath, surfaces.nowPath);
  if (surfaces.emitExternal) {
    for (const t of unparked) {
      try {
        await surfaces.emitExternal({ item: t, reason: "unparked by upstream resolve", cascade: [] }, "unparked");
      } catch (err) {
        console.error(`[park] external unpark emit failed for "${t}":`, err);
      }
    }
  }
  return unparked;
}

// Exposed for tests / direct callers (e.g. lifeofbash sync after manual edits).
export { syncNowParkedSection, refreshNowFromQueue };
