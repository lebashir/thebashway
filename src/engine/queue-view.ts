// src/engine/queue-view.ts
// A read-only, per-surface VIEW of the one queue — the "build-queue split" without forking
// the queue into separate files. Pure: `laneOf` assigns each item exactly one lane and
// `queueView` partitions all items into per-surface lanes + an unrouted bucket + an other
// bucket. It reuses `inSurface` (the same predicate the drain claim path uses) so the view can
// NEVER drift from what `drain --surface` actually claims.
import type { QueueItem } from "./queue";
import { inSurface } from "./queue-ops";

/** A surface as the view needs it: its name + checkout-relative dir (for `inSurface`). */
export interface SurfaceLane {
  name: string;
  dir: string;
}

export interface QueueView {
  /** Routed items keyed by surface name, in the order `surfaces` was given. */
  lanes: Record<string, QueueItem[]>;
  /** Empty-territory items (every @needs-intake capture) — no build lane yet. */
  unrouted: QueueItem[];
  /** Non-empty territory NOT fully under exactly one configured surface — spans surfaces, or
   *  falls under none. The catch-all that makes the partition exhaustive. */
  other: QueueItem[];
}

/**
 * The lane an item belongs to: `"unrouted"` (no territory), a surface NAME (its territory is
 * fully under exactly ONE surface's dir), or `"other"` (zero matches — under no surface — or
 * more than one — territory spans surfaces, e.g. a cross-surface design-run item). Reuses
 * `inSurface`, whose `"."`-dir short-circuit matches every non-empty-territory item.
 */
export function laneOf(item: QueueItem, surfaces: SurfaceLane[]): string {
  if (item.territory.length === 0) return "unrouted";
  const matched = surfaces.filter((s) => inSurface(item, s.dir));
  return matched.length === 1 ? matched[0]!.name : "other";
}

/**
 * Partition every queue item into exactly one bucket: a per-surface lane, `unrouted`, or
 * `other`. INVARIANT (asserted in tests): the sum of all bucket sizes equals `items.length`;
 * no item is ever dropped. `lanes` is pre-seeded with an (possibly empty) array for every
 * configured surface so a quiet lane still renders.
 */
export function queueView(items: QueueItem[], surfaces: SurfaceLane[]): QueueView {
  const lanes: Record<string, QueueItem[]> = {};
  for (const s of surfaces) lanes[s.name] = [];
  const view: QueueView = { lanes, unrouted: [], other: [] };
  for (const item of items) {
    const lane = laneOf(item, surfaces);
    if (lane === "unrouted") view.unrouted.push(item);
    else if (lane === "other") view.other.push(item);
    else (view.lanes[lane] ??= []).push(item);
  }
  return view;
}
