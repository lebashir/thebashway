import { test, expect } from "bun:test";
import { existsSync, openSync, closeSync, unlinkSync, writeSync } from "node:fs";
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
  const fd = openSync(lp, "wx"); // hold it (unstamped — never treated as stale)
  try {
    await expect(withLock(lp, () => 1, { timeoutMs: 80, retryMs: 15 })).rejects.toThrow(/timed out/);
  } finally {
    closeSync(fd);
    unlinkSync(lp);
  }
});

test("reclaims a lock whose owner process is dead", async () => {
  const lp = tmp();
  const fd = openSync(lp, "wx");
  writeSync(fd, `2147483647 ${Date.now()}`); // pid 2^31-1: never a live process; ts fresh
  closeSync(fd);
  const v = await withLock(lp, () => 7, { timeoutMs: 300, retryMs: 15 });
  expect(v).toBe(7);
  expect(existsSync(lp)).toBe(false);
});

test("reclaims a lock older than staleMs even if its pid is alive", async () => {
  const lp = tmp();
  const fd = openSync(lp, "wx");
  writeSync(fd, `${process.pid} ${Date.now() - 60_000}`); // our pid (alive), stamped 60s ago
  closeSync(fd);
  const v = await withLock(lp, () => 9, { timeoutMs: 300, retryMs: 15, staleMs: 30_000 });
  expect(v).toBe(9);
  expect(existsSync(lp)).toBe(false);
});
