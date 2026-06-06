import { test, expect } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitPark, emitUnparkScan, syncNowParkedSection, type ParkEvent } from "../../park";
import { serializeItem, type QueueItem } from "../../queue";

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
