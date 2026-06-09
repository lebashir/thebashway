import { test, expect } from "bun:test";
import { laneOf, queueView, type SurfaceLane } from "../../queue-view";
import type { QueueItem } from "../../queue";

function mkItem(title: string, territory: string[]): QueueItem {
  return { title, status: "unclaimed", goal: "", territory, doneWhen: "", clarifications: [] };
}

const MULTI: SurfaceLane[] = [
  { name: "organs", dir: "organs" },
  { name: "tools", dir: "tools" },
];

test("laneOf: a routed item (territory fully under one surface) → that surface lane", () => {
  expect(laneOf(mkItem("a", ["organs/src/x/**"]), MULTI)).toBe("organs");
  expect(laneOf(mkItem("b", ["tools/jobs/y.ts", "tools/z/**"]), MULTI)).toBe("tools");
});

test("laneOf: empty territory → unrouted (a @needs-intake capture has no lane yet)", () => {
  expect(laneOf(mkItem("c", []), MULTI)).toBe("unrouted");
});

test("laneOf: a MULTI-surface item (spans organs + tools) → other (cold-review finding #1)", () => {
  // design-run enqueues cross-surface items; inSurface requires EVERY glob under ONE dir, so this
  // matches NEITHER lane. It must land in `other`, never vanish.
  expect(laneOf(mkItem("d", ["organs/x/**", "tools/y/**"]), MULTI)).toBe("other");
});

test("laneOf: territory under NO configured surface → other", () => {
  expect(laneOf(mkItem("e", ["docs/readme.md"]), MULTI)).toBe("other");
});

test("queueView: partition is EXHAUSTIVE — every item in exactly one bucket (sum === count)", () => {
  const items = [
    mkItem("organ1", ["organs/a/**"]),
    mkItem("organ2", ["organs/b/**"]),
    mkItem("tool1", ["tools/c/**"]),
    mkItem("intake", []), // unrouted
    mkItem("cross", ["organs/x/**", "tools/y/**"]), // other (spans)
    mkItem("docs", ["docs/z.md"]), // other (no surface)
  ];
  const v = queueView(items, MULTI);
  const total = v.lanes.organs!.length + v.lanes.tools!.length + v.unrouted.length + v.other.length;
  expect(total).toBe(items.length);
  expect(v.lanes.organs!.map((i) => i.title)).toEqual(["organ1", "organ2"]);
  expect(v.lanes.tools!.map((i) => i.title)).toEqual(["tool1"]);
  expect(v.unrouted.map((i) => i.title)).toEqual(["intake"]);
  expect(v.other.map((i) => i.title)).toEqual(["cross", "docs"]);
});

test("queueView: every configured surface gets a (possibly empty) lane, in surfaces order", () => {
  const v = queueView([mkItem("tool1", ["tools/a/**"])], MULTI);
  expect(Object.keys(v.lanes)).toEqual(["organs", "tools"]); // seeded + ordered
  expect(v.lanes.organs).toEqual([]); // quiet lane still renders
});

test("queueView: a single root `.` surface puts every routed item in that one lane (degenerate)", () => {
  const root: SurfaceLane[] = [{ name: "engine", dir: "." }];
  const v = queueView([mkItem("x", ["src/a.ts"]), mkItem("y", ["anything/b/**"]), mkItem("z", [])], root);
  expect(v.lanes.engine!.map((i) => i.title)).toEqual(["x", "y"]); // both routed land in the one lane
  expect(v.unrouted.map((i) => i.title)).toEqual(["z"]); // empty-territory still unrouted
  expect(v.other).toEqual([]);
});
