import { test, expect } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimNext, claimNextN, markBlocked, markDone, appendItem, ensureParkItem, parkItem, unparkScan } from "../../queue-ops";
import { parseQueue, serializeItem, type QueueItem } from "../../queue";

function seed(): string {
  const p = join(tmpdir(), `q-${Math.random().toString(36).slice(2)}.md`);
  // Disjoint territories so the overlap-aware claim guard treats A and B as
  // independently claimable (each test that depends on both claiming relies
  // on this).
  const territoryByTitle: Record<string, string[]> = {
    A: ["tools/a/**"],
    B: ["tools/b/**"],
  };
  const item = (title: string): QueueItem => ({
    title,
    status: "unclaimed",
    goal: "g",
    territory: territoryByTitle[title] ?? ["tools/**"],
    doneWhen: "verify green",
    clarifications: [],
  });
  const md = `# build queue\n\n${serializeItem(item("A"))}\n${serializeItem(item("B"))}`;
  Bun.write(p, md);
  return p;
}

async function readItems(p: string) {
  return parseQueue(await Bun.file(p).text());
}

test("claimNext claims exactly the first unclaimed item and persists", async () => {
  const p = seed();
  const claimed = await claimNext("sess1", "br1", p);
  expect(claimed?.title).toBe("A");
  expect(claimed?.claim).toEqual({ session: "sess1", branch: "br1" });
  const items = await readItems(p);
  expect(items[0].status).toBe("claimed");
  expect(items[1].status).toBe("unclaimed");
  unlinkSync(p);
});

test("a second claimNext gets the next item, then null", async () => {
  const p = seed();
  await claimNext("s", "b", p);
  const second = await claimNext("s", "b2", p);
  expect(second?.title).toBe("B");
  const third = await claimNext("s", "b3", p);
  expect(third).toBeNull();
  unlinkSync(p);
});

test("markBlocked and markDone flip status and persist", async () => {
  const p = seed();
  expect(await markBlocked("A", "smoke red", p)).toBe(true);
  expect(await markDone("B", p)).toBe(true);
  const items = await readItems(p);
  expect(items.find((i) => i.title === "A")?.status).toBe("blocked");
  expect(items.find((i) => i.title === "A")?.blockedReason).toBe("smoke red");
  expect(items.find((i) => i.title === "B")?.status).toBe("done");
  unlinkSync(p);
});

test("claimNextN claims up to N claim-able items at once with per-item branches", async () => {
  const p = seed();
  const claimed = await claimNextN(5, "s", (it) => `br-${it.title}`, p);
  expect(claimed.map((i) => i.title)).toEqual(["A", "B"]);
  expect(claimed[0].claim).toEqual({ session: "s", branch: "br-A" });
  expect(claimed[1].claim).toEqual({ session: "s", branch: "br-B" });
  // A third call returns empty (both claimed).
  const empty = await claimNextN(2, "s", (it) => `br-${it.title}`, p);
  expect(empty).toEqual([]);
  unlinkSync(p);
});

test("DependsOn: B with DependsOn:A is NOT claim-able until A is done", async () => {
  const p = join(tmpdir(), `q-${Math.random().toString(36).slice(2)}.md`);
  const a: QueueItem = { title: "A", status: "unclaimed", goal: "g", territory: ["**"], doneWhen: "v", clarifications: [] };
  const b: QueueItem = { title: "B", status: "unclaimed", goal: "g", territory: ["**"], doneWhen: "v", dependsOn: ["A"], clarifications: [] };
  await Bun.write(p, `# build queue\n\n${serializeItem(a)}\n${serializeItem(b)}`);
  // First claim → A only (B is gated on A).
  const claimed1 = await claimNextN(5, "s", (it) => `br-${it.title}`, p);
  expect(claimed1.map((i) => i.title)).toEqual(["A"]);
  // B still not claim-able while A is in flight.
  const claimed2 = await claimNext("s", "br2", p);
  expect(claimed2).toBeNull();
  // Once A is done, B becomes claim-able.
  await markDone("A", p);
  const claimedB = await claimNext("s", "brB", p);
  expect(claimedB?.title).toBe("B");
  unlinkSync(p);
});

test("parkItem flips status + cascades to dependents (sets @parked-on)", async () => {
  const p = join(tmpdir(), `q-${Math.random().toString(36).slice(2)}.md`);
  const a: QueueItem = { title: "A", status: "unclaimed", goal: "g", territory: ["**"], doneWhen: "v", clarifications: [] };
  const b: QueueItem = { title: "B", status: "unclaimed", goal: "g", territory: ["**"], doneWhen: "v", dependsOn: ["A"], clarifications: [] };
  const c: QueueItem = { title: "C", status: "unclaimed", goal: "g", territory: ["**"], doneWhen: "v", clarifications: [] };
  await Bun.write(p, `# build queue\n\n${serializeItem(a)}\n${serializeItem(b)}\n${serializeItem(c)}`);
  const affected = await parkItem("A", "needs Bashir's call on X", p);
  expect(affected.sort()).toEqual(["A", "B"].sort()); // C unaffected
  const items = await readItems(p);
  expect(items.find((i) => i.title === "A")?.status).toBe("parked");
  expect(items.find((i) => i.title === "A")?.parkReason).toBe("needs Bashir's call on X");
  expect(items.find((i) => i.title === "B")?.status).toBe("parked-on");
  expect(items.find((i) => i.title === "B")?.parkedOn).toBe("A");
  expect(items.find((i) => i.title === "C")?.status).toBe("unclaimed");
  unlinkSync(p);
});

test("unparkScan: when parent is no longer @parked, dependents flip back to @unclaimed", async () => {
  const p = join(tmpdir(), `q-${Math.random().toString(36).slice(2)}.md`);
  // A is unclaimed (Bashir unparked it), B is still @parked-on:A from before
  const a: QueueItem = { title: "A", status: "unclaimed", goal: "g", territory: ["**"], doneWhen: "v", clarifications: [] };
  const b: QueueItem = { title: "B", status: "parked-on", parkedOn: "A", goal: "g", territory: ["**"], doneWhen: "v", dependsOn: ["A"], clarifications: [] };
  await Bun.write(p, `# build queue\n\n${serializeItem(a)}\n${serializeItem(b)}`);
  const unparked = await unparkScan(p);
  expect(unparked).toEqual(["B"]);
  const items = await readItems(p);
  expect(items.find((i) => i.title === "B")?.status).toBe("unclaimed");
  expect(items.find((i) => i.title === "B")?.parkedOn).toBeUndefined();
  unlinkSync(p);
});

test("appendItem adds a new item, header preserved", async () => {
  const p = seed();
  await appendItem(
    { title: "C", status: "unclaimed", goal: "g3", territory: ["organs/**"], doneWhen: "v", clarifications: [] },
    p,
  );
  const text = await Bun.file(p).text();
  expect(text).toContain("# build queue"); // header kept
  const items = await readItems(p);
  expect(items.map((i) => i.title)).toEqual(["A", "B", "C"]);
  unlinkSync(p);
});

test("ensureParkItem creates a lightweight @unclaimed placeholder when the title is absent", async () => {
  const p = seed(); // contains A, B only
  const created = await ensureParkItem("brief-update proposed", "narrow scope", p);
  expect(created).toBe(true);
  const items = await readItems(p);
  const added = items.find((i) => i.title === "brief-update proposed");
  expect(added).toBeDefined();
  expect(added?.status).toBe("unclaimed");
  expect(added?.origin).toBe("auto");
  expect(added?.goal).toBe("narrow scope");
  // Now parkItem has a target to flip — the missing half of the human-gate.
  const affected = await parkItem("brief-update proposed", "narrow scope", p);
  expect(affected).toContain("brief-update proposed");
  expect((await readItems(p)).find((i) => i.title === "brief-update proposed")?.status).toBe("parked");
  unlinkSync(p);
});

test("ensureParkItem is a no-op when an item with that title already exists (any status)", async () => {
  const p = seed();
  // Park A first so it's @parked, then ensure A again — must NOT create a duplicate.
  await parkItem("A", "prior", p);
  const created = await ensureParkItem("A", "different reason", p);
  expect(created).toBe(false);
  const matches = (await readItems(p)).filter((i) => i.title === "A");
  expect(matches).toHaveLength(1);
  expect(matches[0].status).toBe("parked"); // unchanged by the no-op ensure
  expect(matches[0].parkReason).toBe("prior");
  unlinkSync(p);
});

import { markReady } from "../../queue-ops";

test("claim guard: an item overlapping an in-flight claim is skipped", async () => {
  const p = join(tmpdir(), `q-${Math.random().toString(36).slice(2)}.md`);
  const mk = (title: string, terr: string[]): QueueItem =>
    ({ title, status: "unclaimed", goal: "g", territory: terr, doneWhen: "v", clarifications: [] });
  await Bun.write(
    p,
    `# build queue\n\n${serializeItem(mk("A", ["tools/orchestrator/**"]))}\n` +
      `${serializeItem(mk("B", ["tools/orchestrator/queue.ts"]))}\n` +
      `${serializeItem(mk("C", ["organs/src/**"]))}`,
  );
  // One batch: A claims; B overlaps A so it's skipped; C is disjoint so it claims.
  const claimed = await claimNextN(5, "s", (it) => `br-${it.title}`, p);
  expect(claimed.map((i) => i.title)).toEqual(["A", "C"]);
  unlinkSync(p);
});

test("markReady promotes needs-intake to unclaimed", async () => {
  const p = join(tmpdir(), `q-${Math.random().toString(36).slice(2)}.md`);
  const it: QueueItem = { title: "Rough", status: "needs-intake", goal: "g", territory: ["tools/**"], doneWhen: "v", clarifications: [] };
  await Bun.write(p, `# build queue\n\n${serializeItem(it)}`);
  expect(await markReady("Rough", p)).toBe(true);
  const items = await parseQueue(await Bun.file(p).text());
  expect(items[0].status).toBe("unclaimed");
  unlinkSync(p);
});

import { appendCapture } from "../../queue-ops";

test("appendCapture lands a needs-intake item with the given origin", async () => {
  const p = seed();
  await appendCapture({ title: "Fix smoke cwd", origin: "auto" }, p);
  await appendCapture({ title: "Rough thought" }, p); // default origin human
  const items = await readItems(p);
  const auto = items.find((i) => i.title === "Fix smoke cwd");
  const human = items.find((i) => i.title === "Rough thought");
  expect(auto?.status).toBe("needs-intake");
  expect(auto?.origin).toBe("auto");
  expect(human?.status).toBe("needs-intake");
  expect(human?.origin).toBeUndefined(); // human default = no marker
  unlinkSync(p);
});

import { appendCapturesDeduped, recordOpenQuestion, planDedupedCaptures } from "../../queue-ops";

test("planDedupedCaptures partitions by source-dedup + cap, purely", () => {
  const existing = new Set(["todo:a:1"]);
  const caps = [
    { source: "todo:a:1", title: "dup-existing" },
    { source: "todo:a:2", title: "new1" },
    { source: "todo:a:2", title: "dup-batch" }, // within-batch dup
    { source: "todo:a:3", title: "new2" },
    { source: "todo:a:4", title: "over-budget" },
  ];
  const plan = planDedupedCaptures(caps, existing, 2);
  expect(plan.appended.map((c) => c.title)).toEqual(["new1", "new2"]);
  expect(plan.skippedExisting.map((c) => c.title)).toEqual(["dup-existing", "dup-batch"]);
  expect(plan.skippedBudget.map((c) => c.title)).toEqual(["over-budget"]);
  expect([...existing]).toEqual(["todo:a:1"]); // pure: the input set is not mutated
});

test("appendCapturesDeduped dedups by source, caps at max, and dedups within a batch", async () => {
  const p = join(tmpdir(), `q-${Math.random().toString(36).slice(2)}.md`);
  await Bun.write(p, `# build queue\n`);
  const caps = [
    { title: "one", source: "todo:a.ts:1111" },
    { title: "two", source: "todo:a.ts:2222" },
    { title: "two-dup", source: "todo:a.ts:2222" }, // within-batch dup → collapses
    { title: "three", source: "todo:a.ts:3333" },
  ];
  const r = await appendCapturesDeduped(caps, { max: 2 }, p);
  expect(r.appended.map((c) => c.title)).toEqual(["one", "two"]);
  expect(r.skippedBudget.map((c) => c.title)).toEqual(["three"]); // the unique 3rd is over budget
  const items = await readItems(p);
  expect(items.map((i) => i.title)).toEqual(["one", "two"]);
  expect(items.every((i) => i.status === "needs-intake" && i.origin === "auto")).toBe(true);
  unlinkSync(p);
});

test("appendCapturesDeduped skips a source already present in ANY status (incl. @done)", async () => {
  const p = join(tmpdir(), `q-${Math.random().toString(36).slice(2)}.md`);
  const done: QueueItem = {
    title: "already shipped",
    status: "done",
    source: "todo:a.ts:dead",
    goal: "g",
    territory: ["t/**"],
    doneWhen: "v",
    clarifications: [],
  };
  await Bun.write(p, `# build queue\n\n${serializeItem(done)}`);
  const r = await appendCapturesDeduped([{ title: "resurrect?", source: "todo:a.ts:dead" }], { max: 5 }, p);
  expect(r.appended).toHaveLength(0);
  expect(r.skippedExisting).toHaveLength(1); // a @done source must NOT come back
  unlinkSync(p);
});

test("recordOpenQuestion sets the field, keeps needs-intake; false for other statuses", async () => {
  const p = join(tmpdir(), `q-${Math.random().toString(36).slice(2)}.md`);
  const needs: QueueItem = { title: "Rough", status: "needs-intake", goal: "", territory: ["t/**"], doneWhen: "", clarifications: [] };
  const ready: QueueItem = { title: "Ready", status: "unclaimed", goal: "g", territory: ["t/**"], doneWhen: "v", clarifications: [] };
  await Bun.write(p, `# build queue\n\n${serializeItem(needs)}\n${serializeItem(ready)}`);
  expect(await recordOpenQuestion("Rough", "Which surface owns approach A: or B?", p)).toBe(true);
  expect(await recordOpenQuestion("Ready", "n/a", p)).toBe(false); // not needs-intake
  expect(await recordOpenQuestion("Missing", "n/a", p)).toBe(false);
  const items = await readItems(p);
  const it = items.find((i) => i.title === "Rough");
  expect(it?.status).toBe("needs-intake"); // still not claimable
  expect(it?.openQuestion).toBe("Which surface owns approach A: or B?");
  unlinkSync(p);
});

import { previewClaimable } from "../../queue-ops";

test("previewClaimable: a root surface (dir '.') claims items whose territory has no leading './'", async () => {
  // Portability: a single-root repo (thebashway, nextjs-minimal) declares surface dir ".".
  // inSurface must treat "." as the whole repo, not require territory to start with "./".
  const p = join(tmpdir(), `q-${Math.random().toString(36).slice(2)}.md`);
  const it: QueueItem = {
    title: "Root item",
    status: "unclaimed",
    goal: "g",
    territory: ["src/engine/foo.ts"],
    doneWhen: "v",
    clarifications: [],
  };
  await Bun.write(p, `# build queue\n\n${serializeItem(it)}`);
  const claimable = await previewClaimable(5, p, { surfaceDir: "." });
  expect(claimable.map((i) => i.title)).toContain("Root item");
  unlinkSync(p);
});
