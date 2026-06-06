import { test, expect } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recheckManifest } from "../../manifest-check";
import { sha256 } from "../manifest";
import type { Runner } from "../types";

const KNOWN_DIFF = "diff --git a/x b/x\n+hello\n";
// Returns KNOWN_DIFF for `git diff <base> <head>`.
const fakeRun: Runner = async (cmd) =>
  cmd[0] === "git" && cmd[1] === "diff"
    ? { code: 0, stdout: KNOWN_DIFF, stderr: "" }
    : { code: 0, stdout: "", stderr: "" };

function writeManifest(diffSha256: string): string {
  const p = join(tmpdir(), `m-${Math.random().toString(36).slice(2)}.json`);
  Bun.write(
    p,
    JSON.stringify({
      surface: "tools",
      baseRef: "BASE",
      head: "HEAD",
      territory: [],
      diffSha256,
      outputSha256: "x",
      checks: [],
      ok: true,
      ts: "t",
    }),
  );
  return p;
}

test("passes when the manifest diff hash matches the real diff", async () => {
  const p = writeManifest(sha256(KNOWN_DIFF));
  const r = await recheckManifest(p, "/repo", fakeRun);
  expect(r.ok).toBe(true);
  unlinkSync(p);
});

test("fails when the diff hash does not match (tampered)", async () => {
  const p = writeManifest(sha256("a different diff"));
  const r = await recheckManifest(p, "/repo", fakeRun);
  expect(r.ok).toBe(false);
  expect(r.reason).toContain("mismatch");
  unlinkSync(p);
});
