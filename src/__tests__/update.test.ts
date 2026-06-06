import { test, expect } from "bun:test";
import { runUpdate, type Runner } from "../update";

/** A fake command runner: answers git/bun by matching the joined args, with successive
 *  `rev-parse --short HEAD` outputs drawn from `heads` (before, then after the pull). */
function fakeRunner(opts: {
  toplevelStatus?: number;
  dirty?: string;
  heads?: string[];
  pullStatus?: number;
  pullErr?: string;
  installStatus?: number;
  installErr?: string;
}): Runner {
  let headIdx = 0;
  const heads = opts.heads ?? ["aaaaaaa", "aaaaaaa"];
  return (cmd, args) => {
    const a = args.join(" ");
    if (cmd === "git" && a.includes("rev-parse --show-toplevel")) {
      return { status: opts.toplevelStatus ?? 0, stdout: "/x/thebashway\n", stderr: "" };
    }
    if (cmd === "git" && a.includes("status --porcelain")) {
      return { status: 0, stdout: opts.dirty ?? "", stderr: "" };
    }
    if (cmd === "git" && a.includes("rev-parse --short HEAD")) {
      const h = heads[Math.min(headIdx, heads.length - 1)];
      headIdx++;
      return { status: 0, stdout: `${h}\n`, stderr: "" };
    }
    if (cmd === "git" && a.includes("pull")) {
      return { status: opts.pullStatus ?? 0, stdout: "", stderr: opts.pullErr ?? "" };
    }
    if (cmd === "bun" && a.includes("install")) {
      return { status: opts.installStatus ?? 0, stdout: "", stderr: opts.installErr ?? "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

const PKG = "/x/thebashway";

test("not a git checkout → refuses, changes nothing", () => {
  const r = runUpdate({ pkgRoot: PKG, run: fakeRunner({ toplevelStatus: 1 }) });
  expect(r.ok).toBe(false);
  expect(r.changed).toBe(false);
  expect(r.message).toContain("not a git checkout");
});

test("dirty working tree → refuses to clobber local changes", () => {
  const r = runUpdate({ pkgRoot: PKG, run: fakeRunner({ dirty: " M src/cli.ts\n" }) });
  expect(r.ok).toBe(false);
  expect(r.changed).toBe(false);
  expect(r.message).toContain("local uncommitted changes");
});

test("already up to date → ok, no change, no install", () => {
  const r = runUpdate({ pkgRoot: PKG, run: fakeRunner({ heads: ["aaaaaaa", "aaaaaaa"] }) });
  expect(r.ok).toBe(true);
  expect(r.changed).toBe(false);
  expect(r.message).toContain("Already up to date");
});

test("HEAD moved + install ok → updated", () => {
  const r = runUpdate({ pkgRoot: PKG, run: fakeRunner({ heads: ["aaaaaaa", "bbbbbbb"] }) });
  expect(r.ok).toBe(true);
  expect(r.changed).toBe(true);
  expect(r.before).toBe("aaaaaaa");
  expect(r.after).toBe("bbbbbbb");
  expect(r.message).toContain("Updated thebashway aaaaaaa → bbbbbbb");
});

test("git pull fails (diverged / offline) → reports, no change", () => {
  const r = runUpdate({ pkgRoot: PKG, run: fakeRunner({ pullStatus: 1, pullErr: "not a fast-forward" }) });
  expect(r.ok).toBe(false);
  expect(r.changed).toBe(false);
  expect(r.message).toContain("git pull failed");
  expect(r.message).toContain("not a fast-forward");
});

test("HEAD moved but bun install fails → flagged, points at the clone", () => {
  const r = runUpdate({
    pkgRoot: PKG,
    run: fakeRunner({ heads: ["aaaaaaa", "bbbbbbb"], installStatus: 1, installErr: "lockfile conflict" }),
  });
  expect(r.ok).toBe(false);
  expect(r.changed).toBe(true);
  expect(r.message).toContain("bun install` failed");
  expect(r.message).toContain("lockfile conflict");
});
