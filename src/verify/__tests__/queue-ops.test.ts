import { test, expect } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimNext, claimNextN, markBlocked, markDone, appendItem, parkItem, unparkScan } from "../../queue-ops";
import { parseQueue, serializeItem, type QueueItem } from "../../queue";

function seed(): string {
  const p = join(tmpdir(), `q-${Math.random().toString(36).slice(2)}.md`);
  const item = (title: string): QueueItem => ({
    title,
    status: "unclaimed",
    goal: "g",
    territory: ["tools/**"],
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
