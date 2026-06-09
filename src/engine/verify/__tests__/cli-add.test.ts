import { test, expect } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCapture, markReady } from "../../queue-ops";
import { parseQueue } from "../../queue";

test("add then mark-ready promotes a captured item to build-ready", async () => {
  const p = join(tmpdir(), `q-${Math.random().toString(36).slice(2)}.md`);
  await Bun.write(p, `# build queue\n`);
  await appendCapture({ title: "Wire the new gate" }, p); // what `add` does
  let items = parseQueue(await Bun.file(p).text());
  expect(items[0]!.status).toBe("needs-intake"); // provably present: appendCapture just wrote one item
  expect(await markReady("Wire the new gate", p)).toBe(true); // what `mark-ready` does
  items = parseQueue(await Bun.file(p).text());
  expect(items[0]!.status).toBe("unclaimed"); // same item, now promoted
  unlinkSync(p);
});
