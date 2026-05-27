import { test, expect } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimNext, markBlocked, markDone, appendItem } from "../../queue-ops";
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
