import { test, expect } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { areasForItem, listIntakeCandidates, summarizeIntake } from "../../auto-intake";
import { serializeItem, type QueueItem } from "../../queue";

const SURFACES = { tools: { dir: "tools" }, organs: { dir: "organs" } };

test("areasForItem maps territory→surface; bare ** → all; non-surface → none", () => {
  expect(areasForItem({ territory: ["tools/orchestrator/**"] }, SURFACES)).toEqual(["tools"]);
  expect(areasForItem({ territory: ["organs/src/x.ts"] }, SURFACES)).toEqual(["organs"]);
  expect(areasForItem({ territory: ["**"] }, SURFACES).sort()).toEqual(["organs", "tools"]);
  expect(areasForItem({ territory: ["NOW.md"] }, SURFACES)).toEqual([]);
  expect(areasForItem({ territory: ["tools/a.ts", "organs/b.ts"] }, SURFACES).sort()).toEqual([
    "organs",
    "tools",
  ]);
});

test("summarizeIntake renders promoted + deferred", () => {
  expect(summarizeIntake(["A", "B"], [])).toBe("auto-intake: promoted 2");
  expect(summarizeIntake(["A"], [{ title: "B", question: "which dir?" }])).toBe(
    "auto-intake: promoted 1; 1 need input: B",
  );
});

test("listIntakeCandidates returns only @needs-intake items with an assembled Loop A prompt", async () => {
  const qp = join(tmpdir(), `q-${Math.random().toString(36).slice(2)}.md`);
  const dp = join(tmpdir(), `d-${Math.random().toString(36).slice(2)}.md`);
  const needs: QueueItem = {
    title: "Rough",
    status: "needs-intake",
    source: "todo:x:ab12cd34",
    goal: "",
    territory: ["tools/**"],
    doneWhen: "",
    clarifications: [],
  };
  const ready: QueueItem = {
    title: "Ready",
    status: "unclaimed",
    goal: "g",
    territory: ["tools/**"],
    doneWhen: "v",
    clarifications: [],
  };
  await Bun.write(qp, `# build queue\n\n${serializeItem(needs)}\n${serializeItem(ready)}`);
  await Bun.write(dp, "# decisions\n\n## Active\n\n- [decision] Prefer the lean option.\n- [tools] Some tools rule.\n");

  const cands = await listIntakeCandidates({ queuePath: qp, decisionsPath: dp, surfaces: SURFACES });
  expect(cands).toHaveLength(1); // the @unclaimed item is excluded
  expect(cands[0].item.title).toBe("Rough");
  expect(cands[0].areas).toEqual(["tools"]);
  expect(cands[0].intakePrompt).toContain("Prefer the lean option"); // global [decision] injected
  expect(cands[0].intakePrompt).toContain("Some tools rule"); // area [tools] injected
  expect(cands[0].intakePrompt).toContain("Title: Rough");
  unlinkSync(qp);
  unlinkSync(dp);
});
