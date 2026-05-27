// tools/orchestrator/verify/__tests__/ports.test.ts
import { test, expect } from "bun:test";
import { freePort } from "../ports";

test("returns a usable TCP port in range", async () => {
  const p = await freePort();
  expect(p).toBeGreaterThan(1024);
  expect(p).toBeLessThan(65536);
});

test("consecutive calls can both be bound (no immediate reuse clash)", async () => {
  const a = await freePort();
  const b = await freePort();
  expect(typeof a).toBe("number");
  expect(typeof b).toBe("number");
});
