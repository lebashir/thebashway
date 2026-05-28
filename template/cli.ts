#!/usr/bin/env bun
// tools/orchestrator/cli.ts  (PROJECT-SPECIFIC — copy this template + adapt)
// Thin per-project CLI that wires thebashway's primitives to YOUR surfaces
// and YOUR external sinks (e.g. agent feed, Slack). The skill refers to
// commands by name; this script makes `bun run thebashway <cmd>` work.
//
// Add to your package.json:
//   "scripts": { "thebashway": "bun run path/to/cli.ts" }
//
// Subcommands implemented below are the minimal set the skill references —
// you can extend.
import { resolve } from "node:path";
import {
  preflight,
  seedWorktree,
  parseSeedList,
  claimNextN,
  markDone,
  emitPark,
  emitUnparkScan,
  type PreflightSurface,
  type ParkEvent,
} from "thebashway";
import { SURFACES, MAX_CONCURRENT_BASHAS, DEFAULT_BRANCH_PATTERN } from "./config";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const QUEUE_PATH = resolve(import.meta.dir, "queue.md");
const NOW_PATH = resolve(REPO_ROOT, "NOW.md");
const SEED_LIST_PATH = resolve(import.meta.dir, "preflight-seed.txt");

/**
 * OPTIONAL: replace this stub with your project's external sink (e.g. Supabase
 * insert into an agent_events table that a dashboard reads). The CLI passes
 * park/unpark events through here. Throwing is non-fatal — emitPark logs and
 * proceeds, so a missing sink doesn't block the build loop.
 */
async function emitExternal(_event: ParkEvent, _kind: "parked" | "unparked"): Promise<void> {
  // example wiring (uncomment + adapt):
  // const s = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { ... });
  // await s.from("agent_events").insert({ source: "thebashway", action: kind, target: event.item, payload: { reason: event.reason, cascade: event.cascade } });
}

async function loadSeedPaths(): Promise<string[]> {
  const f = Bun.file(SEED_LIST_PATH);
  if (!(await f.exists())) return [];
  return parseSeedList(await f.text());
}

function sessionId(arg?: string): string {
  return arg || process.env.CLAUDE_SESSION_ID || process.env.USER || "anon";
}

async function cmdPreflight(name: string): Promise<number> {
  const cfg = SURFACES[name];
  if (!cfg) { console.error(`unknown surface: ${name}`); return 2; }
  const surface: PreflightSurface = {
    name,
    cwd: resolve(REPO_ROOT, cfg.dir),
    regen: cfg.regen ?? undefined,
    branchPattern: DEFAULT_BRANCH_PATTERN,
    seedPaths: await loadSeedPaths(),
  };
  const r = await preflight(surface);
  for (const c of r.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  return r.ok ? 0 : 1;
}

async function cmdClaim(n: number, session: string): Promise<number> {
  const claimed = await claimNextN(
    n,
    session,
    (it) => `tbw/${it.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
    QUEUE_PATH,
  );
  console.log(JSON.stringify(claimed, null, 2));
  return claimed.length > 0 ? 0 : 1;
}

async function cmdPark(title: string, reason: string): Promise<number> {
  const evt = await emitPark(title, reason, { queuePath: QUEUE_PATH, nowPath: NOW_PATH, emitExternal });
  console.log(`parked: ${evt.item}${evt.cascade.length ? ` (cascade: ${evt.cascade.join(", ")})` : ""}`);
  return 0;
}

async function cmdUnpark(): Promise<number> {
  const u = await emitUnparkScan({ queuePath: QUEUE_PATH, nowPath: NOW_PATH, emitExternal });
  console.log(u.length ? `unparked: ${u.join(", ")}` : "nothing to unpark");
  return 0;
}

async function cmdDone(title: string): Promise<number> {
  const ok = await markDone(title, QUEUE_PATH);
  console.log(ok ? `done: ${title}` : `not found: ${title}`);
  return ok ? 0 : 1;
}

async function cmdSeed(workPath: string): Promise<number> {
  const r = await seedWorktree(workPath, REPO_ROOT, await loadSeedPaths());
  for (const p of r.copied) console.log(`  ✓ ${p}`);
  for (const p of r.skipped) console.log(`  ↷ ${p}`);
  for (const p of r.missing) console.log(`  ✗ ${p}`);
  return r.missing.length ? 1 : 0;
}

function usage() {
  console.error(`usage: bun run thebashway <cmd>
  preflight <surface>
  claim <n> [--session <id>]
  park <title> <reason...>
  unpark-scan
  done <title>
  seed-worktree <work-path>
config: maxConcurrentBashas=${MAX_CONCURRENT_BASHAS}, surfaces=${Object.keys(SURFACES).join(", ")}`);
}

const [sub, ...args] = process.argv.slice(2);
let code = 0;
try {
  switch (sub) {
    case "preflight": code = await cmdPreflight(args[0]); break;
    case "claim": {
      const n = Math.max(1, Math.min(MAX_CONCURRENT_BASHAS, Number(args[0] || MAX_CONCURRENT_BASHAS)));
      const sFlag = args.indexOf("--session");
      code = await cmdClaim(n, sessionId(sFlag >= 0 ? args[sFlag + 1] : undefined));
      break;
    }
    case "park": code = args[0] && args.length > 1 ? await cmdPark(args[0], args.slice(1).join(" ")) : (usage(), 2); break;
    case "unpark-scan": code = await cmdUnpark(); break;
    case "done": code = args[0] ? await cmdDone(args[0]) : (usage(), 2); break;
    case "seed-worktree": code = args[0] ? await cmdSeed(args[0]) : (usage(), 2); break;
    default: usage(); code = 2;
  }
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  code = 1;
}
process.exit(code);
