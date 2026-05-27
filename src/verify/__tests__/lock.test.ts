import { test, expect } from "bun:test";
import { existsSync, openSync, closeSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLock } from "../../lock";

const tmp = () => join(tmpdir(), `lock-${Math.random().toString(36).slice(2)}`);

test("runs fn, returns its value, removes the lockfile after", async () => {
  const lp = tmp();
  const v = await withLock(lp, () => 42);
  expect(v).toBe(42);
  expect(existsSync(lp)).toBe(false);
});

test("two concurrent holders serialize (no lost update)", async () => {
  const lp = tmp();
  let shared = 0;
  const bump = async () => {
    const v = shared;
    await new Promise((r) => setTimeout(r, 15));
    shared = v + 1;
  };
  await Promise.all([withLock(lp, bump), withLock(lp, bump)]);
  expect(shared).toBe(2); // interleaved would give 1
  expect(existsSync(lp)).toBe(false);
});

test("times out when the lock is held and never released", async () => {
  const lp = tmp();
  const fd = openSync(lp, "wx"); // hold it
  try {
    await expect(withLock(lp, () => 1, { timeoutMs: 80, retryMs: 15 })).rejects.toThrow(/timed out/);
  } finally {
    closeSync(fd);
    unlinkSync(lp);
  }
});
