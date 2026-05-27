// tools/orchestrator/lock.ts
// Advisory mutex via exclusive-create lockfile. macOS has no flock(1), so we use
// O_EXCL create + spin-retry. This is the multi-session coordination primitive:
// concurrent sessions serialize their queue.md read-claim-write window through it.
import { openSync, closeSync, unlinkSync } from "node:fs";

export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  opts: { timeoutMs?: number; retryMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const retryMs = opts.retryMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx"); // exclusive create — throws EEXIST if held
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() > deadline) throw new Error(`withLock: timed out acquiring ${lockPath}`);
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
  try {
    return await fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone — fine
    }
  }
}
