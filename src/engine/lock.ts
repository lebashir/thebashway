// tools/orchestrator/lock.ts
// Advisory mutex via exclusive-create lockfile. macOS has no flock(1), so we use
// O_EXCL create + spin-retry. This is the multi-session coordination primitive:
// concurrent sessions serialize their queue.md read-claim-write window through it.
//
// Stale-lock recovery: each holder stamps the lockfile with "<pid> <acquiredMs>".
// If acquisition keeps failing, a held lock is reclaimed when its owner PID is dead
// OR it is older than `staleMs` — so a crashed session can't wedge every future one.
// A lock with no readable stamp (legacy / external holder) is NEVER reclaimed: we
// don't steal a lock we can't reason about.
import { openSync, closeSync, unlinkSync, writeSync, readFileSync } from "node:fs";

/** Liveness probe: signal 0 throws ESRCH for a dead pid, EPERM for a live one we can't signal. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A held lock is stale if its owner is dead or it's older than staleMs. Unreadable or
 * un-stamped locks are treated as NOT stale. */
function lockIsStale(lockPath: string, staleMs: number): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8").trim();
  } catch {
    return false; // gone or unreadable — let the normal retry handle it
  }
  const [pidStr, tsStr] = raw.split(/\s+/);
  const pid = Number(pidStr);
  const ts = Number(tsStr);
  if (Number.isFinite(pid) && pid > 0 && !pidAlive(pid)) return true;
  if (Number.isFinite(ts) && Date.now() - ts > staleMs) return true;
  return false;
}

export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  opts: { timeoutMs?: number; retryMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const retryMs = opts.retryMs ?? 20;
  const staleMs = opts.staleMs ?? 30000;
  const deadline = Date.now() + timeoutMs;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx"); // exclusive create — throws EEXIST if held
      writeSync(fd, `${process.pid} ${Date.now()}`); // stamp owner + acquisition time
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Held — reclaim it if the holder is dead or it's gone stale, else wait.
      if (lockIsStale(lockPath, staleMs)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // another reclaimer won the race — fall through and retry
        }
        continue; // retry the create immediately, no backoff
      }
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
