import { test, expect } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedWorktree, parseSeedList } from "../../worktree-seed";

async function makeRepo(): Promise<{ repo: string; work: string }> {
  const repo = await mkdtemp(join(tmpdir(), "tbw-repo-"));
  const work = await mkdtemp(join(tmpdir(), "tbw-work-"));
  return { repo, work };
}

test("parseSeedList ignores blanks and `#` comments", () => {
  const text = `# comment\n\norgans/.env.local\n# another\ntools/.env\n`;
  expect(parseSeedList(text)).toEqual(["organs/.env.local", "tools/.env"]);
});

test("seedWorktree copies present source files to the worktree, preserving subdirs", async () => {
  const { repo, work } = await makeRepo();
  await mkdir(join(repo, "organs"), { recursive: true });
  await writeFile(join(repo, "organs", ".env.local"), "SUPABASE_URL=x\n");
  const r = await seedWorktree(work, repo, ["organs/.env.local"]);
  expect(r.copied).toEqual(["organs/.env.local"]);
  expect(r.skipped).toEqual([]);
  expect(r.missing).toEqual([]);
  expect(readFileSync(join(work, "organs", ".env.local"), "utf8")).toBe("SUPABASE_URL=x\n");
  rmSync(repo, { recursive: true });
  rmSync(work, { recursive: true });
});

test("seedWorktree skips files that already exist in the worktree (idempotent re-spawn)", async () => {
  const { repo, work } = await makeRepo();
  await mkdir(join(repo, "organs"), { recursive: true });
  await mkdir(join(work, "organs"), { recursive: true });
  await writeFile(join(repo, "organs", ".env.local"), "from-repo\n");
  await writeFile(join(work, "organs", ".env.local"), "from-work\n");
  const r = await seedWorktree(work, repo, ["organs/.env.local"]);
  expect(r.copied).toEqual([]);
  expect(r.skipped).toEqual(["organs/.env.local"]);
  expect(readFileSync(join(work, "organs", ".env.local"), "utf8")).toBe("from-work\n");
  rmSync(repo, { recursive: true });
  rmSync(work, { recursive: true });
});

test("seedWorktree reports paths whose source is missing", async () => {
  const { repo, work } = await makeRepo();
  const r = await seedWorktree(work, repo, ["organs/.env.local", "tools/.env"]);
  expect(r.copied).toEqual([]);
  expect(r.missing.sort()).toEqual(["organs/.env.local", "tools/.env"].sort());
  expect(existsSync(join(work, "organs", ".env.local"))).toBe(false);
  rmSync(repo, { recursive: true });
  rmSync(work, { recursive: true });
});
