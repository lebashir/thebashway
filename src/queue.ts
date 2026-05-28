// tools/orchestrator/queue.ts
// The shared build queue format + parser. ONE item per top-level `- [ ]`/`- [x]`
// bullet; indented `Key: value` sub-lines carry fields; a `Clarifications:` block
// holds `- Q: ... A: ...` lines. The `@` tag on the title line is the claim/status
// marker. See tools/orchestrator/queue.md for the canonical example.
//
// Status grammar:
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
//   DependsOn:      — comma-separated titles of items that must finish first
//   Park-reason:    — set by parkItem; rendered as a separate line for grep-ability
//   Clarifications: — block of `- Q: ... A: ...` lines
export type QueueStatus =
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
  if (m) return { status: "claimed", claim: { session: m[1], branch: m[2] } };
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
  const head = block[0];
  const doneBox = /^- \[x\]/.test(head);
  const tagSplit = head.replace(/^- \[[ x]\]\s*/, "");
  const atIdx = tagSplit.lastIndexOf("@");
  const title = (atIdx >= 0 ? tagSplit.slice(0, atIdx) : tagSplit).trim();
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
      if (m) item.clarifications.push({ q: m[1], a: m[2] });
      continue;
    }
    const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = kv[2].trim();
    if (key === "goal") { item.goal = val; inClar = false; }
    else if (key === "territory") { item.territory = val.split(",").map((s) => s.trim()).filter(Boolean); inClar = false; }
    else if (key === "done-when") { item.doneWhen = val; inClar = false; }
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
    item.status === "unclaimed" ? "@unclaimed"
    : item.status === "done" ? "@done"
    : item.status === "blocked" ? `@blocked (${item.blockedReason ?? ""})`
    : item.status === "parked" ? `@parked (${item.parkReason ?? ""})`
    : item.status === "parked-on" ? `@parked-on:${item.parkedOn ?? ""}`
    : `@${item.claim?.session} / ${item.claim?.branch}`;
  const lines = [
    `- [${box}] ${item.title}        ${tag}`,
    `  Goal: ${item.goal}`,
    `  Territory: ${item.territory.join(", ")}`,
    `  Done-when: ${item.doneWhen}`,
  ];
  if (item.dependsOn?.length) lines.push(`  DependsOn: ${item.dependsOn.join(", ")}`);
  if (item.status === "parked" && item.parkReason) {
    lines.push(`  Park-reason: ${item.parkReason}`);
  }
  if (item.clarifications.length) {
    lines.push("  Clarifications:");
    for (const c of item.clarifications) lines.push(`    - Q: ${c.q} A: ${c.a}`);
  }
  return lines.join("\n") + "\n";
}
