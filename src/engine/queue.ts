// tools/orchestrator/queue.ts
// The shared build queue format + parser. ONE item per top-level `- [ ]`/`- [x]`
// bullet; indented `Key: value` sub-lines carry fields; a `Clarifications:` block
// holds `- Q: ... A: ...` lines. The `@` tag on the title line is the claim/status
// marker. See tools/orchestrator/queue.md for the canonical example.
//
// Status grammar:
//   @needs-intake               — rough capture; NOT build-ready (cannot be claimed)
//   @unclaimed                  — ready to claim
//   @<session> / <branch>       — claimed, in flight
//   @done                       — shipped (also flip the box to `- [x]`)
//   @blocked (reason)           — circuit-breaker / budget abort
//   @parked (reason)            — needs Bashir; NOT blocking other items (run mode)
//   @parked-on:<title>          — auto-set when DependsOn points at a parked item
//
// Optional fields on an item:
//   Goal:           — what the unit produces
//   Territory:      — comma-separated globs scope-diff enforces
//   Done-when:      — exit criteria
//   Source:         — dedup fingerprint for a machine-captured item (e.g. a swept TODO);
//                     idempotent re-sweeps skip a fingerprint already present in the queue
//   DependsOn:      — comma-separated titles of items that must finish first
//   Open-question:  — set by recordOpenQuestion (the conservative auto-intake "defer" path):
//                     a free-text question that keeps the item @needs-intake until answered
//   Park-reason:    — set by parkItem; rendered as a separate line for grep-ability
//   Clarifications: — block of `- Q: ... A: ...` lines
export type QueueStatus =
  | "needs-intake"
  | "unclaimed"
  | "claimed"
  | "blocked"
  | "done"
  | "parked"
  | "parked-on";

export interface QueueItem {
  title: string;
  status: QueueStatus;
  claim?: { session: string; branch: string };
  blockedReason?: string;
  parkReason?: string;
  parkedOn?: string; // title of the parent parked item
  /** Who created the item. "auto" = self-enqueued by a basha. Absent = human. */
  origin?: "auto" | "human";
  /** Dedup fingerprint for a machine-captured item (e.g. `todo:<relpath>:<hash>`). */
  source?: string;
  /** Open intake question that keeps the item @needs-intake (conservative auto-intake defer). */
  openQuestion?: string;
  goal: string;
  territory: string[];
  doneWhen: string;
  /** Titles of items that must finish first. Optional (default: none). */
  dependsOn?: string[];
  clarifications: { q: string; a: string }[];
}

function parseTag(
  tag: string,
): Pick<QueueItem, "status" | "claim" | "blockedReason" | "parkReason" | "parkedOn"> {
  const t = tag.trim();
  if (t === "@needs-intake") return { status: "needs-intake" };
  if (t === "@unclaimed") return { status: "unclaimed" };
  if (t === "@done") return { status: "done" };
  if (t.startsWith("@blocked")) {
    const m = t.match(/^@blocked\s*\(([^)]*)\)/);
    return { status: "blocked", blockedReason: m?.[1]?.trim() };
  }
  if (t.startsWith("@parked-on")) {
    const m = t.match(/^@parked-on:\s*(.+)$/);
    return { status: "parked-on", parkedOn: m?.[1]?.trim() };
  }
  if (t.startsWith("@parked")) {
    const m = t.match(/^@parked\s*(?:\(([^)]*)\))?/);
    return { status: "parked", parkReason: m?.[1]?.trim() };
  }
  // "@session-X / branch-Y"
  const m = t.match(/^@(\S+)\s*\/\s*(\S+)/);
  if (m) return { status: "claimed", claim: { session: m[1]!, branch: m[2]! } }; // groups 1,2 exist after match
  return { status: "unclaimed" };
}

/** Split markdown into top-level bullet blocks, then parse each. */
export function parseQueue(md: string): QueueItem[] {
  // Strip HTML comment regions first — commented-out examples are not live items.
  const lines = md.replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const blocks: string[][] = [];
  let cur: string[] | null = null;
  for (const line of lines) {
    if (/^- \[[ x]\]/.test(line)) {
      if (cur) blocks.push(cur);
      cur = [line];
    } else if (cur && (line.startsWith("  ") || line.trim() === "")) {
      cur.push(line);
    } else if (cur && !line.startsWith("-")) {
      cur.push(line);
    }
  }
  if (cur) blocks.push(cur);
  return blocks.map(parseBlock);
}

function parseBlock(block: string[]): QueueItem {
  const head = block[0]!; // parseBlock only called for blocks with ≥1 element
  const doneBox = /^- \[x\]/.test(head);
  const tagSplit = head.replace(/^- \[[ x]\]\s*/, "");
  const atIdx = tagSplit.lastIndexOf("@");
  const rawTitle = (atIdx >= 0 ? tagSplit.slice(0, atIdx) : tagSplit).trim();
  const originMatch = rawTitle.match(/\s*\(origin:\s*auto\)\s*$/i);
  const title = rawTitle.replace(/\s*\(origin:\s*auto\)\s*$/i, "").trim();
  const tag = atIdx >= 0 ? tagSplit.slice(atIdx) : "@unclaimed";
  const tagParsed = parseTag(tag);
  const status = doneBox ? "done" : tagParsed.status;

  const item: QueueItem = {
    title,
    status,
    claim: tagParsed.claim,
    blockedReason: tagParsed.blockedReason,
    parkReason: tagParsed.parkReason,
    parkedOn: tagParsed.parkedOn,
    origin: originMatch ? "auto" : undefined,
    goal: "",
    territory: [],
    doneWhen: "",
    dependsOn: undefined,
    clarifications: [],
  };

  let inClar = false;
  for (const raw of block.slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^Clarifications:/i.test(line)) { inClar = true; continue; }
    if (inClar && line.startsWith("- Q:")) {
      const m = line.match(/^- Q:\s*(.*?)\s*A:\s*(.*)$/);
      if (m) item.clarifications.push({ q: m[1]!, a: m[2]! }); // groups 1,2 exist after match
      continue;
    }
    const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase(); // group 1 exists after match
    const val = kv[2]!.trim(); // group 2 exists after match
    if (key === "goal") { item.goal = val; inClar = false; }
    else if (key === "territory") { item.territory = val.split(",").map((s) => s.trim()).filter(Boolean); inClar = false; }
    else if (key === "done-when") { item.doneWhen = val; inClar = false; }
    else if (key === "source") { if (val) item.source = val; inClar = false; }
    else if (key === "open-question") { if (val) item.openQuestion = val; inClar = false; }
    else if (key === "dependson" || key === "depends-on") {
      const list = val.split(",").map((s) => s.trim()).filter(Boolean);
      if (list.length) item.dependsOn = list;
      inClar = false;
    }
    else if (key === "park-reason") { item.parkReason = val; inClar = false; }
  }
  return item;
}

/** Render an item back to the canonical block format (round-trips parseQueue). */
export function serializeItem(item: QueueItem): string {
  const box = item.status === "done" ? "x" : " ";
  const tag =
    item.status === "needs-intake" ? "@needs-intake"
    : item.status === "unclaimed" ? "@unclaimed"
    : item.status === "done" ? "@done"
    : item.status === "blocked" ? `@blocked (${item.blockedReason ?? ""})`
    : item.status === "parked" ? `@parked (${item.parkReason ?? ""})`
    : item.status === "parked-on" ? `@parked-on:${item.parkedOn ?? ""}`
    : `@${item.claim?.session} / ${item.claim?.branch}`;
  const originMark = item.origin === "auto" ? " (origin: auto)" : "";
  const lines = [
    `- [${box}] ${item.title}${originMark}        ${tag}`,
    `  Goal: ${item.goal}`,
    `  Territory: ${item.territory.join(", ")}`,
    `  Done-when: ${item.doneWhen}`,
  ];
  if (item.source) lines.push(`  Source: ${item.source}`);
  if (item.dependsOn?.length) lines.push(`  DependsOn: ${item.dependsOn.join(", ")}`);
  if (item.openQuestion) lines.push(`  Open-question: ${item.openQuestion}`);
  if (item.status === "parked" && item.parkReason) {
    lines.push(`  Park-reason: ${item.parkReason}`);
  }
  if (item.clarifications.length) {
    lines.push("  Clarifications:");
    for (const c of item.clarifications) lines.push(`    - Q: ${c.q} A: ${c.a}`);
  }
  return lines.join("\n") + "\n";
}
