// src/engine/verify/__tests__/brief-eval.test.ts
// Decision-logic tests for the termination ORACLE (spec 8d). A FAKE Runner exercises
// every kind's verdict — exit-0 -> pass, non-zero -> fail, TIMEOUT -> fail, verify ->
// delegate to runChain, file-exists true/false. NO real process is spawned; only the
// real kill-wiring in bunRun stays un-unit-tested.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateCheckSpec } from "../../brief-eval";
import { CheckSpecSchema } from "../../brief";
import type { Runner, RunResult } from "../types";

const spec = (raw: unknown) => CheckSpecSchema.parse(raw);

const okRunner: Runner = async () => ({ code: 0, stdout: "ok", stderr: "" });

test("command: exit 0 (default expectExit) => pass", async () => {
  const r = await evaluateCheckSpec(spec({ kind: "command", run: "true" }), {
    repoRoot: "/repo",
    run: okRunner,
  });
  expect(r.pass).toBe(true);
});

test("command: non-zero exit => fail", async () => {
  const run: Runner = async () => ({ code: 1, stdout: "", stderr: "boom" });
  const r = await evaluateCheckSpec(spec({ kind: "command", run: "false" }), {
    repoRoot: "/repo",
    run,
  });
  expect(r.pass).toBe(false);
});

test("command: a non-default expectExit is honored (exit matches => pass)", async () => {
  const run: Runner = async () => ({ code: 3, stdout: "", stderr: "" });
  const r = await evaluateCheckSpec(spec({ kind: "command", run: "exit 3", expectExit: 3 }), {
    repoRoot: "/repo",
    run,
  });
  expect(r.pass).toBe(true);
});

test("command: TIMEOUT => fail (a timed-out run never passes, even if it carries exit 0)", async () => {
  // A timeout sentinel: even with code:0 and expectExit:0, timedOut:true forces a fail.
  const timeoutRunner: Runner = async () => ({
    code: 0,
    stdout: "",
    stderr: "[timed out]",
    timedOut: true,
  } satisfies RunResult);
  const r = await evaluateCheckSpec(spec({ kind: "command", run: "sleep 999", expectExit: 0 }), {
    repoRoot: "/repo",
    run: timeoutRunner,
  });
  expect(r.pass).toBe(false);
});

test("command: the per-CheckSpec timeoutMs is passed to the Runner, cwd pinned to repoRoot", async () => {
  let seen: { cwd?: string; timeoutMs?: number } | undefined;
  let seenCmd: string[] | undefined;
  const run: Runner = async (cmd, opts) => {
    seenCmd = cmd;
    seen = opts;
    return { code: 0, stdout: "", stderr: "" };
  };
  await evaluateCheckSpec(spec({ kind: "command", run: "echo hi && exit 0", timeoutMs: 5000 }), {
    repoRoot: "/repo",
    run,
  });
  expect(seen?.cwd).toBe("/repo");
  expect(seen?.timeoutMs).toBe(5000);
  // shell string is run via a shell so `&&` semantics hold.
  expect(seenCmd?.[0]).toBe("bash");
  expect(seenCmd?.[seenCmd.length - 1]).toBe("echo hi && exit 0");
});

test("command: default timeoutMs (60s) is applied when the spec omits it", async () => {
  let seenTimeout: number | undefined;
  const run: Runner = async (_cmd, opts) => {
    seenTimeout = opts?.timeoutMs;
    return { code: 0, stdout: "", stderr: "" };
  };
  await evaluateCheckSpec(spec({ kind: "command", run: "true" }), { repoRoot: "/repo", run });
  expect(seenTimeout).toBe(60_000);
});

test("verify: delegates to runChain — a failing chain => fail", async () => {
  // runner fails the first check => chain.ok === false.
  const run: Runner = async (cmd) =>
    cmd[0] === "lint"
      ? { code: 1, stdout: "", stderr: "lint boom" }
      : { code: 0, stdout: "ok", stderr: "" };
  const r = await evaluateCheckSpec(spec({ kind: "verify" }), {
    repoRoot: "/repo",
    run,
    surface: { dir: "engine", chain: [{ name: "lint", cmd: ["lint"] }, { name: "test", cmd: ["test"] }] },
  });
  expect(r.pass).toBe(false);
});

test("verify: delegates to runChain — an all-green chain => pass", async () => {
  const r = await evaluateCheckSpec(spec({ kind: "verify" }), {
    repoRoot: "/repo",
    run: okRunner,
    surface: { dir: "engine", chain: [{ name: "lint", cmd: ["lint"] }, { name: "test", cmd: ["test"] }] },
  });
  expect(r.pass).toBe(true);
});

test("verify: no surface to delegate to => fail (cannot confirm met)", async () => {
  const r = await evaluateCheckSpec(spec({ kind: "verify" }), { repoRoot: "/repo", run: okRunner });
  expect(r.pass).toBe(false);
});

test("file-exists: injected exists probe true/false drives the verdict", async () => {
  const present = await evaluateCheckSpec(spec({ kind: "file-exists", path: "dist/out.js" }), {
    repoRoot: "/repo",
    run: okRunner,
    exists: (p) => p === "/repo/dist/out.js",
  });
  expect(present.pass).toBe(true);

  const absent = await evaluateCheckSpec(spec({ kind: "file-exists", path: "dist/missing.js" }), {
    repoRoot: "/repo",
    run: okRunner,
    exists: () => false,
  });
  expect(absent.pass).toBe(false);
});

test("file-exists: real filesystem (default existsSync) — present vs absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brief-eval-"));
  try {
    writeFileSync(join(dir, "present.txt"), "x");
    const present = await evaluateCheckSpec(spec({ kind: "file-exists", path: "present.txt" }), {
      repoRoot: dir,
      run: okRunner,
    });
    expect(present.pass).toBe(true);

    const absent = await evaluateCheckSpec(spec({ kind: "file-exists", path: "nope.txt" }), {
      repoRoot: dir,
      run: okRunner,
    });
    expect(absent.pass).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
