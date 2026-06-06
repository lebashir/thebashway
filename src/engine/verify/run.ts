// tools/orchestrator/verify/run.ts
import type { RunResult, Runner } from "./types";

/** Default Runner: spawn a process, capture stdout/stderr + exit code. */
export const bunRun: Runner = async (cmd, opts = {}) => {
  const proc = Bun.spawn({
    cmd,
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr } satisfies RunResult;
};

export function parseNameOnly(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Changed files between `base` and `head` (repo-root-relative). */
export async function changedFiles(
  base: string,
  head: string,
  cwd: string,
  run: Runner = bunRun,
): Promise<string[]> {
  const r = await run(["git", "diff", "--name-only", base, head], { cwd });
  return parseNameOnly(r.stdout);
}

/** Raw diff text between `base` and `head` (input to the manifest hash). */
export async function diffText(
  base: string,
  head: string,
  cwd: string,
  run: Runner = bunRun,
): Promise<string> {
  const r = await run(["git", "diff", base, head], { cwd });
  return r.stdout;
}

export async function gitHead(cwd: string, run: Runner = bunRun): Promise<string> {
  const r = await run(["git", "rev-parse", "HEAD"], { cwd });
  return r.stdout.trim();
}

// --- name-status (added in Plan 2) ---
export interface FileChange {
  status: "A" | "M" | "D";
  path: string;
}

/**
 * Parse `git diff --name-status`. Renames (`R<score>\told\tnew`) and copies
 * (`C...`) collapse to a Modified on the NEW path — for required-touches we only
 * care that the destination changed.
 */
export function parseNameStatus(stdout: string): FileChange[] {
  const out: FileChange[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0][0]; // first char: A/M/D/R/C
    if (code === "R" || code === "C") {
      out.push({ status: "M", path: parts[2] ?? parts[1] });
    } else if (code === "A" || code === "M" || code === "D") {
      out.push({ status: code, path: parts[1] });
    }
  }
  return out;
}

export async function changedWithStatus(
  base: string,
  head: string,
  cwd: string,
  run: Runner = bunRun,
): Promise<FileChange[]> {
  const r = await run(["git", "diff", "--name-status", base, head], { cwd });
  return parseNameStatus(r.stdout);
}
