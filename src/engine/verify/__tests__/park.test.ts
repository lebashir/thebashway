import { test, expect } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitPark, emitUnparkScan, syncNowParkedSection, type ParkEvent } from "../../park";
import { parseQueue, serializeItem, type QueueItem } from "../../queue";

const BRIEF_UPDATE_PARK_TITLE = "brief-update proposed";

function tmp(): string {
  return join(tmpdir(), `park-${Math.random().toString(36).slice(2)}.md`);
}

const itemUnclaimed = (title: string, dependsOn?: string[]): QueueItem => ({
  title,
  status: "unclaimed",
  goal: "g",
  territory: ["**"],
  doneWhen: "v",
  dependsOn,
  clarifications: [],
});

async function seedTwo(): Promise<{ qPath: string; nowPath: string }> {
  const qPath = tmp();
  const nowPath = tmp();
  await Bun.write(
    qPath,
    `# queue\n\n${serializeItem(itemUnclaimed("A"))}\n${serializeItem(itemUnclaimed("B", ["A"]))}`,
  );
  await Bun.write(nowPath, `---\ncreated: 2026-05-28\n---\n\n# Now\n\nbody.\n`);
  return { qPath, nowPath };
}

test("emitPark sets @parked + cascades + writes NOW.md `## Parked` section", async () => {
  const { qPath, nowPath } = await seedTwo();
  const evt = await emitPark("A", "needs schema call", { queuePath: qPath, nowPath });
  expect(evt.item).toBe("A");
  expect(evt.cascade).toEqual(["B"]);
  const nowText = await Bun.file(nowPath).text();
  expect(nowText).toContain("## Parked — needs your call");
  expect(nowText).toContain("- A — needs schema call");
  // B is dependent; surface only the directly-parked item in NOW (the cascade
  // is implied by the queue's DependsOn graph).
  expect(nowText).not.toContain("- B —");
  unlinkSync(qPath);
  unlinkSync(nowPath);
});

test("emitPark calls emitExternal exactly once with kind='parked'", async () => {
  const { qPath, nowPath } = await seedTwo();
  const calls: { event: ParkEvent; kind: string }[] = [];
  await emitPark("A", "x", {
    queuePath: qPath,
    nowPath,
    emitExternal: async (event, kind) => { calls.push({ event, kind }); },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0].kind).toBe("parked");
  expect(calls[0].event.item).toBe("A");
  unlinkSync(qPath);
  unlinkSync(nowPath);
});

test("emitPark survives a failing external sink (logs error, succeeds)", async () => {
  const { qPath, nowPath } = await seedTwo();
  await emitPark("A", "x", {
    queuePath: qPath,
    nowPath,
    emitExternal: async () => { throw new Error("supabase down"); },
  });
  // Queue still flipped; NOW still updated.
  const nowText = await Bun.file(nowPath).text();
  expect(nowText).toContain("- A — x");
  unlinkSync(qPath);
  unlinkSync(nowPath);
});

test("emitUnparkScan refreshes NOW.md (drops resolved parks) + emits unparked external events", async () => {
  const { qPath, nowPath } = await seedTwo();
  await emitPark("A", "x", { queuePath: qPath, nowPath });
  // Simulate Bashir unparking A by editing queue.md back to @unclaimed.
  let qText = await Bun.file(qPath).text();
  qText = qText.replace(/@parked \(x\)/, "@unclaimed").replace(/\n\s*Park-reason:.*\n/, "\n");
  await Bun.write(qPath, qText);

  const externalCalls: { event: ParkEvent; kind: string }[] = [];
  const unparked = await emitUnparkScan({
    queuePath: qPath,
    nowPath,
    emitExternal: async (event, kind) => { externalCalls.push({ event, kind }); },
  });
  expect(unparked).toEqual(["B"]);
  expect(externalCalls).toHaveLength(1);
  expect(externalCalls[0].kind).toBe("unparked");
  expect(externalCalls[0].event.item).toBe("B");
  const nowText = await Bun.file(nowPath).text();
  expect(nowText).not.toContain("- A — x");
  unlinkSync(qPath);
  unlinkSync(nowPath);
});

test("syncNowParkedSection: empty lines list removes the section", async () => {
  const nowPath = tmp();
  await Bun.write(nowPath, `---\ncreated: 2026-05-28\n---\n\n## Parked — needs your call\n\n- A — old\n\n## Current focus\n\nbody.\n`);
  await syncNowParkedSection(nowPath, []);
  const text = await Bun.file(nowPath).text();
  expect(text).not.toContain("## Parked");
  expect(text).toContain("## Current focus");
  unlinkSync(nowPath);
});

// --- The human-gate liveness: an engine-originated park whose title was NEVER enqueued
//     (a brief-update proposal, a milestone stop-and-ask) must STILL land on queue.md +
//     NOW.md. parkItem alone only flips an existing item, so without the ensure step the
//     park would write nothing and be silently lost. These drive the REAL emitPark. ---

async function seedEmptyQueueAndNow(): Promise<{ qPath: string; nowPath: string }> {
  const qPath = tmp();
  const nowPath = tmp();
  // A queue with a header + ONE unrelated unclaimed item — the brief-update title is absent.
  await Bun.write(qPath, `# queue\n\n${serializeItem(itemUnclaimed("some other thing"))}`);
  await Bun.write(nowPath, `---\ncreated: 2026-06-08\n---\n\n# Now\n\nbody.\n`);
  return { qPath, nowPath };
}

test("emitPark of a NEVER-ENQUEUED title creates + parks it in queue.md AND surfaces in NOW.md", async () => {
  const { qPath, nowPath } = await seedEmptyQueueAndNow();
  const reason = "[milestone epic] proposed brief update (human-gated): narrow scope";

  const evt = await emitPark(BRIEF_UPDATE_PARK_TITLE, reason, { queuePath: qPath, nowPath });
  expect(evt.item).toBe(BRIEF_UPDATE_PARK_TITLE);

  // queue.md: the proposal is now a real @parked item (not silently dropped).
  const items = parseQueue(await Bun.file(qPath).text());
  const parked = items.find((i) => i.title === BRIEF_UPDATE_PARK_TITLE);
  expect(parked).toBeDefined();
  expect(parked?.status).toBe("parked");
  expect(parked?.parkReason).toBe(reason);
  // The pre-existing unrelated item is untouched.
  expect(items.find((i) => i.title === "some other thing")?.status).toBe("unclaimed");

  // NOW.md: the `## Parked` section was rebuilt from the queue and carries the proposal line.
  const nowText = await Bun.file(nowPath).text();
  expect(nowText).toContain("## Parked — needs your call");
  expect(nowText).toContain(`- ${BRIEF_UPDATE_PARK_TITLE} — ${reason}`);

  unlinkSync(qPath);
  unlinkSync(nowPath);
});

test("emitPark is idempotent on the title: a second park does NOT duplicate the queue item", async () => {
  const { qPath, nowPath } = await seedEmptyQueueAndNow();
  await emitPark(BRIEF_UPDATE_PARK_TITLE, "first", { queuePath: qPath, nowPath });
  await emitPark(BRIEF_UPDATE_PARK_TITLE, "second", { queuePath: qPath, nowPath });

  const items = parseQueue(await Bun.file(qPath).text());
  const matches = items.filter((i) => i.title === BRIEF_UPDATE_PARK_TITLE);
  // Exactly ONE item with that title — ensureParkItem no-ops when the item already exists,
  // so the rate-limit scan (status:'parked' && title===…) sees a real prior park to suppress on.
  expect(matches).toHaveLength(1);
  expect(matches[0].status).toBe("parked");

  unlinkSync(qPath);
  unlinkSync(nowPath);
});

test("emitPark surfaces the autonomous milestone stop-and-ask title that no drain ever enqueues", async () => {
  const { qPath, nowPath } = await seedEmptyQueueAndNow();
  const title = "machine criteria met — human milestone judgment pending";
  await emitPark(title, "targeted machine criteria pass; human milestone judgment pending", {
    queuePath: qPath,
    nowPath,
  });
  const items = parseQueue(await Bun.file(qPath).text());
  expect(items.find((i) => i.title === title)?.status).toBe("parked");
  expect(await Bun.file(nowPath).text()).toContain(`- ${title} —`);
  unlinkSync(qPath);
  unlinkSync(nowPath);
});
