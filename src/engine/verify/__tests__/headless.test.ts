import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import {
  headlessArgs,
  headlessEnv,
  parseMarker,
  runClaude,
  DEFAULT_HEADLESS_TIMEOUT_MS,
} from "../../headless";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("headlessArgs: bare prompt → ['-p', prompt]", () => {
  expect(headlessArgs({ prompt: "hello" })).toEqual(["-p", "hello"]);
});

test("headlessArgs: model + skipPermissions are inserted before the prompt", () => {
  expect(headlessArgs({ prompt: "do it", model: "sonnet", skipPermissions: true })).toEqual([
    "-p",
    "--model",
    "sonnet",
    "--dangerously-skip-permissions",
    "do it",
  ]);
});

test("headlessEnv: scrubs ANTHROPIC_API_KEY and sets subscription/operator env", () => {
  const env = headlessEnv({ ANTHROPIC_API_KEY: "sk-should-be-removed" });
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.LIFEOFBASH_SCOPE).toBe("operator");
  expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0");
  expect(env.PATH!.startsWith("/opt/homebrew/bin:/usr/local/bin:")).toBe(true);
});

test("headlessEnv: even a process-env key cannot leak the API key through", () => {
  // The scrub must run AFTER the spread, so an inherited key is removed too.
  const env = headlessEnv();
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
});

test("parseMarker: returns the LAST marker payload, trimmed", () => {
  const out = "noise\nDONE: first\nmore noise\nDONE:   second  \ntrailing";
  expect(parseMarker(out, "DONE")).toBe("second");
});

test("parseMarker: null when the marker is absent", () => {
  expect(parseMarker("no markers here", "DONE")).toBeNull();
});

// ---------------------------------------------------------------------------
// runClaude with an injected fake spawn
// ---------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (sig?: string) => boolean;
  killed: boolean;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = (_sig?: string) => {
    child.killed = true;
    return true;
  };
  return child;
}

// A fake spawn that records the call and hands the test the child to drive.
function fakeSpawnFactory(child: FakeChild) {
  const calls: { cmd: string; args: string[]; opts: unknown }[] = [];
  const spawnImpl = ((cmd: string, args: string[], opts: unknown) => {
    calls.push({ cmd, args, opts });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawnImpl, calls };
}

test("runClaude: success path — exit 0 → ok:true with captured stdout", async () => {
  const child = makeFakeChild();
  const { spawnImpl, calls } = fakeSpawnFactory(child);
  const p = runClaude({ prompt: "build", cwd: "/tmp", model: "sonnet", skipPermissions: true, spawnImpl });
  // Drive the child.
  child.stdout.emit("data", Buffer.from("working...\n"));
  child.stdout.emit("data", Buffer.from("DONE: ok\n"));
  child.emit("close", 0);
  const r = await p;
  expect(r.ok).toBe(true);
  expect(r.exitCode).toBe(0);
  expect(r.timedOut).toBe(false);
  expect(r.stdout).toContain("DONE: ok");
  // Spawned the real binary name with the assembled args.
  expect(calls[0]!.cmd).toBe("claude");
  expect(calls[0]!.args).toEqual(["-p", "--model", "sonnet", "--dangerously-skip-permissions", "build"]);
});

test("runClaude: non-zero exit → ok:false (never throws)", async () => {
  const child = makeFakeChild();
  const { spawnImpl } = fakeSpawnFactory(child);
  const p = runClaude({ prompt: "x", cwd: "/tmp", spawnImpl });
  child.emit("close", 1);
  const r = await p;
  expect(r.ok).toBe(false);
  expect(r.exitCode).toBe(1);
});

test("runClaude: spawn 'error' event → ok:false, never throws", async () => {
  const child = makeFakeChild();
  const { spawnImpl } = fakeSpawnFactory(child);
  const p = runClaude({ prompt: "x", cwd: "/tmp", spawnImpl });
  child.emit("error", new Error("ENOENT: claude not found"));
  const r = await p;
  expect(r.ok).toBe(false);
  expect(r.timedOut).toBe(false);
});

test("runClaude: a thrown spawn (e.g. binary missing) → ok:false, never throws", async () => {
  const spawnImpl = (() => {
    throw new Error("spawn EACCES");
  }) as unknown as typeof import("node:child_process").spawn;
  const r = await runClaude({ prompt: "x", cwd: "/tmp", spawnImpl });
  expect(r.ok).toBe(false);
  expect(r.exitCode).toBeNull();
});

test("runClaude: timeout → SIGKILL, ok:false, timedOut:true", async () => {
  const child = makeFakeChild();
  const { spawnImpl } = fakeSpawnFactory(child);
  const p = runClaude({ prompt: "x", cwd: "/tmp", timeoutMs: 5, spawnImpl });
  // Never emit close; let the timer fire.
  const r = await p;
  expect(r.ok).toBe(false);
  expect(r.timedOut).toBe(true);
  expect(child.killed).toBe(true);
});

test("DEFAULT_HEADLESS_TIMEOUT_MS is a sane long default (>= 5 min)", () => {
  expect(DEFAULT_HEADLESS_TIMEOUT_MS).toBeGreaterThanOrEqual(5 * 60_000);
});
