import { test, expect } from "bun:test";
import { noopSinks } from "../sinks";

test("noopSinks never throw and report nothing", async () => {
  const s = noopSinks();
  await s.notify("hi");
  await s.eventSink({ action: "parked", target: "x" });
  expect(await s.statusFile.refreshParked([])).toBeUndefined();
});
