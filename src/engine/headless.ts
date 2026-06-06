// tools/orchestrator/headless.ts
// The reusable headless engine: shell out to `claude -p` on the Max subscription
// (UNMETERED — ANTHROPIC_API_KEY is deleted from the child env; it then
// authenticates via the subscription and cannot be billed). Generalized from the
// proven tg-capture-drain.ts pattern (the Stage 3 spike). Used by the OUT-door
// drain loop (drain.ts) and the IN-door audit fan-out (audit-run.ts).
//
// Design: NEVER throws. A spawn error, a non-zero exit, or a timeout all resolve
// to `{ ok: false }` so callers branch on a boolean, never a try/catch. The spawn
// itself is injectable (`spawnImpl`) so unit tests drive a fake child and never
// launch a real `claude`.
import { spawn as nodeSpawn } from "node:child_process";

export interface HeadlessOptions {
  /** The full prompt handed to `claude -p`. */
  prompt: string;
  /** Working directory for the child (e.g. a worktree, or the repo root). */
  cwd: string;
  /** Model tier → `--model`. Omit for the subscription default. */
  model?: "sonnet" | "opus";
  /** Add `--dangerously-skip-permissions` (build bashas that edit/commit need it). */
  skipPermissions?: boolean;
  /** Hard wall-clock cap; on expiry the child is SIGKILLed. Default 20 min. */
  timeoutMs?: number;
  /** Extra env merged over the scrubbed base env. */
  env?: Record<string, string>;
  /** Injectable spawn (tests pass a fake). Defaults to node:child_process.spawn. */
  spawnImpl?: typeof nodeSpawn;
}

export interface HeadlessResult {
  /** Exit code 0 AND not timed out. */
  ok: boolean;
  /** Full captured stdout (even on failure/timeout). */
  stdout: string;
  /** The child's exit code, or null if it never exited cleanly (timeout/error). */
  exitCode: number | null;
  /** True iff the wall-clock cap fired and the child was killed. */
  timedOut: boolean;
}

/** A generous default — a build basha may run TDD + a full verify chain. */
export const DEFAULT_HEADLESS_TIMEOUT_MS = 20 * 60_000;

/** Assemble the `claude -p` argv. Flags precede the prompt (the positional arg). */
export function headlessArgs(opts: {
  prompt: string;
  model?: string;
  skipPermissions?: boolean;
}): string[] {
  const args = ["-p"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.skipPermissions) args.push("--dangerously-skip-permissions");
  args.push(opts.prompt);
  return args;
}

/**
 * Build the child env. The scrub runs AFTER the spread so an inherited (or
 * `extra`-supplied) ANTHROPIC_API_KEY can never leak through — subscription auth
 * is the only path, which is what makes this unmeterable. Matches the
 * tg-capture-drain.ts env exactly (operator scope, homebrew PATH, TLS workaround).
 */
export function headlessEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...process.env, ...(extra ?? {}) } as Record<string, string>;
  delete env.ANTHROPIC_API_KEY;
  env.LIFEOFBASH_SCOPE = "operator";
  // launchd's minimal PATH lacks /opt/homebrew/bin where `claude` lives; prepend it.
  env.PATH = `/opt/homebrew/bin:/usr/local/bin:${env.PATH ?? "/usr/bin:/bin"}`;
  // Tabby machine: TLS to the API/registry needs this; harmless elsewhere.
  env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  return env;
}

/**
 * Extract the payload of the LAST `MARKER: <payload>` line in `stdout`, trimmed.
 * Bashas signal a structured result by printing such a line (the existing CoS
 * jobs use `PROCESSED:`; the drain build basha uses `DONE:` / `BLOCKED:`).
 * Returns null when the marker is absent.
 */
export function parseMarker(stdout: string, marker: string): string | null {
  const re = new RegExp(`^${marker}:\\s*(.*)$`);
  let found: string | null = null;
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(re);
    if (m) found = m[1].trim();
  }
  return found;
}

/**
 * Run `claude -p` headless. Never throws; resolves to a HeadlessResult.
 * The child env is scrubbed of ANTHROPIC_API_KEY (subscription auth, unmetered).
 */
export async function runClaude(opts: HeadlessOptions): Promise<HeadlessResult> {
  const spawnImpl = opts.spawnImpl ?? nodeSpawn;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HEADLESS_TIMEOUT_MS;
  const args = headlessArgs(opts);
  const env = headlessEnv(opts.env);

  return new Promise<HeadlessResult>((resolve) => {
    let out = "";
    let settled = false;
    let timedOut = false;

    let child: ReturnType<typeof nodeSpawn>;
    try {
      child = spawnImpl("claude", args, { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      // Synchronous spawn failure (e.g. EACCES). Never throw.
      resolve({ ok: false, stdout: "", exitCode: null, timedOut: false });
      return;
    }

    const finish = (r: HeadlessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore — we resolve below regardless
      }
      finish({ ok: false, stdout: out, exitCode: null, timedOut: true });
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer | string) => {
      out += d.toString();
    });
    child.stderr?.on("data", () => {
      // Swallowed; the exit code is the signal. (stderr is noisy in -p mode.)
    });
    child.on("error", () => {
      finish({ ok: false, stdout: out, exitCode: null, timedOut: false });
    });
    child.on("close", (code: number | null) => {
      finish({ ok: code === 0, stdout: out, exitCode: code, timedOut });
    });
  });
}
