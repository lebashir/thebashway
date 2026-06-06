// src/update.ts
// `thebashway update` core: pull the latest engine into the package clone (git, fast-forward
// only) and reinstall deps if anything changed. Every project that uses thebashway references
// this one clone, so a single update reaches them all; per-project `thebashway.config.ts` +
// `.thebashway/` stores are untouched. The skill is a symlink into `skill/`, so it auto-follows.
//
// Side effects (git/bun) go through an INJECTED `run` seam so the decision logic is unit-tested
// without touching the network or the filesystem (mirrors check-sync.ts's injected gitLog).

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}
export type Runner = (cmd: string, args: string[], cwd: string) => RunResult;

export interface UpdateReport {
  ok: boolean;
  /** true if HEAD actually moved (a real update happened). */
  changed: boolean;
  before: string | null;
  after: string | null;
  message: string;
}

export interface UpdateOpts {
  /** The package clone's root (where .git + package.json live). */
  pkgRoot: string;
  /** Injected command runner (real = spawnSync). */
  run: Runner;
}

/**
 * Update the thebashway clone in place. Order: confirm it is a git checkout → refuse if the
 * working tree is dirty (never clobber local edits) → `git pull --ff-only` → `bun install` iff
 * HEAD moved. Returns a report; `ok=false` means nothing was changed unsafely (the failure modes
 * all stop before or report cleanly).
 */
export function runUpdate(opts: UpdateOpts): UpdateReport {
  const { pkgRoot, run } = opts;
  const git = (...a: string[]) => run("git", ["-C", pkgRoot, ...a], pkgRoot);

  // 1. Must be a git checkout (someone could have installed the package another way).
  if (git("rev-parse", "--show-toplevel").status !== 0) {
    return {
      ok: false,
      changed: false,
      before: null,
      after: null,
      message: `thebashway at ${pkgRoot} is not a git checkout — update by reinstalling it from source.`,
    };
  }

  // 2. Refuse to clobber local uncommitted changes.
  const dirty = git("status", "--porcelain");
  if (dirty.status === 0 && dirty.stdout.trim() !== "") {
    return {
      ok: false,
      changed: false,
      before: null,
      after: null,
      message: `thebashway has local uncommitted changes at ${pkgRoot} — commit or stash them, then run update again.`,
    };
  }

  // 3. Capture HEAD, fast-forward pull, capture HEAD again. ff-only so a diverged local history
  //    fails loudly instead of creating a surprise merge commit.
  const before = git("rev-parse", "--short", "HEAD").stdout.trim() || null;
  const pull = git("pull", "--ff-only");
  if (pull.status !== 0) {
    return {
      ok: false,
      changed: false,
      before,
      after: before,
      message: `git pull failed (not a fast-forward, or you're offline):\n${(pull.stderr || pull.stdout).trim()}`,
    };
  }
  const after = git("rev-parse", "--short", "HEAD").stdout.trim() || null;
  const changed = !!before && !!after && before !== after;

  if (!changed) {
    return { ok: true, changed: false, before, after, message: `Already up to date (${after ?? "unknown"}).` };
  }

  // 4. HEAD moved — dependencies may have too; reinstall.
  const install = run("bun", ["install"], pkgRoot);
  if (install.status !== 0) {
    return {
      ok: false,
      changed: true,
      before,
      after,
      message: `Pulled ${before} → ${after}, but \`bun install\` failed — run it by hand in ${pkgRoot}:\n${(install.stderr || install.stdout).trim()}`,
    };
  }

  return {
    ok: true,
    changed: true,
    before,
    after,
    message: `Updated thebashway ${before} → ${after} (bun install ok). Every project that uses it now gets the new version; the skill auto-follows its symlink.`,
  };
}
