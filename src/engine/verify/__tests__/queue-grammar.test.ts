import { test, expect } from "bun:test";
import { parseQueue, serializeItem, type QueueItem } from "../../queue";

const base = (over: Partial<QueueItem> = {}): QueueItem => ({
  title: "X",
  status: "unclaimed",
  goal: "g",
  territory: ["tools/**"],
  doneWhen: "verify green",
  clarifications: [],
  ...over,
});

test("needs-intake round-trips through serialize -> parse", () => {
  const md = serializeItem(base({ title: "Rough idea", status: "needs-intake" }));
  const [item] = parseQueue(md);
  expect(item.status).toBe("needs-intake");
  expect(item.title).toBe("Rough idea");
});

test("origin:auto round-trips and defaults to human when absent", () => {
  const withAuto = parseQueue(serializeItem(base({ origin: "auto" })))[0];
  expect(withAuto.origin).toBe("auto");
  // A legacy line with no origin parses as undefined (treated as human by callers).
  const legacy = parseQueue("- [ ] Old item        @unclaimed\n  Goal: g\n  Territory: tools/**\n  Done-when: v")[0];
  expect(legacy.origin).toBeUndefined();
});

import { claimNext } from "../../queue-ops";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a @needs-intake item is never claim-able", async () => {
  const p = join(tmpdir(), `q-${Math.random().toString(36).slice(2)}.md`);
  await Bun.write(p, `# build queue\n\n${serializeItem(base({ title: "Rough", status: "needs-intake" }))}`);
  expect(await claimNext("s", "b", p)).toBeNull();
  unlinkSync(p);
});
