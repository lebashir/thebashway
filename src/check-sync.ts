// src/check-sync.ts
// Drift guard. The package's engine was extracted from lifeofbash/tools/orchestrator
// and then GENERALIZED — so a file-by-file hash compare is meaningless (the files
// intentionally differ now). What matters is whether lifeofbash's engine has gained
// NEW commits (a fix or capability) that this package hasn't picked up. So check-sync
// reports the commits to the reference engine path since the recorded reconciliation
// ref (.sync-ref). See SYNC.md.

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

export const DEFAULT_REFERENCE_REPO = "/Users/bachir.habib/lifeofbash";
export const REFERENCE_PATH = "tools/orchestrator";

/** Parse `git log --oneline` output into trimmed commit lines (drift candidates). */
export function parseDriftLog(logOutput: string): string[] {
  return logOutput
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export interface SyncReport {
  sinceRef: string | null;
  commits: string[];
  inSync: boolean;
}

export interface CheckSyncOpts {
  referenceRepo?: string;
  /** The lifeofbash commit this package was last reconciled to. null = unknown. */
  sinceRef: string | null;
  /** Injectable git runner (tests pass a fake). */
  gitLog?: (repo: string, args: string[]) => string;
}

export function checkSync(opts: CheckSyncOpts): SyncReport {
  if (!opts.sinceRef) return { sinceRef: null, commits: [], inSync: false };
  const repo = opts.referenceRepo ?? DEFAULT_REFERENCE_REPO;
  const run =
    opts.gitLog ??
    ((r: string, a: string[]) => spawnSync("git", ["-C", r, ...a], { encoding: "utf8" }).stdout ?? "");
  const out = run(repo, ["log", "--oneline", `${opts.sinceRef}..HEAD`, "--", REFERENCE_PATH]);
  const commits = parseDriftLog(out);
  return { sinceRef: opts.sinceRef, commits, inSync: commits.length === 0 };
}

/** Read the recorded reconciliation ref from .sync-ref, if present. */
export function readSyncRef(path: string): string | null {
  if (!existsSync(path)) return null;
  const v = readFileSync(path, "utf8").trim();
  return v.length > 0 ? v : null;
}

if (import.meta.main) {
  const refPath = new URL("../.sync-ref", import.meta.url).pathname;
  const ref = readSyncRef(refPath);
  if (!ref) {
    console.log("check-sync: no .sync-ref recorded — cannot compute drift.");
    process.exit(0);
  }
  const report = checkSync({ sinceRef: ref });
  if (report.inSync) {
    console.log(`In sync with lifeofbash tools/orchestrator @ ${ref} (no new commits).`);
  } else {
    console.log(`DRIFT: ${report.commits.length} commit(s) to tools/orchestrator since ${ref}:`);
    for (const c of report.commits) console.log(`  ${c}`);
    console.log(`\nReconcile what's relevant, then update .sync-ref to lifeofbash HEAD.`);
  }
}
