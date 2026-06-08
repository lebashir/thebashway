import { test, expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { runReflect, BRIEF_UPDATE_PARK_TITLE, type RunReflectDeps } from "../../reflect";
import { appendReflection, type ReflectionRecord } from "../../digest";
import { emitPark } from "../../park";
import { parseQueue } from "../../queue";

// A fake park sink that records (title, reason) calls and lets us simulate an already-parked queue.
function fakeDeps(over: Partial<RunReflectDeps> = {}): {
  deps: RunReflectDeps;
  parks: { title: string; reason: string }[];
  logged: ReflectionRecord[];
} {
  const parks: { title: string; reason: string }[] = [];
  const logged: ReflectionRecord[] = [];
  const deps: RunReflectDeps = {
    appendReflection: async (_logPath, r) => {
      logged.push(r);
    },
    emitPark: async (title, reason) => {
      parks.push({ title, reason });
    },
    readQueue: async () => "", // empty queue = nothing already parked
    ...over,
  };
  return { deps, parks, logged };
}

const baseOpts = {
  milestone: "epic: north-star",
  learned: ["the seam stayed pure"],
  briefStillValid: true,
  onPath: true,
  logPath: "/tmp/does-not-matter.md",
  queuePath: "/tmp/queue.md",
};

test("per-feature land (isMilestone:false) logs a lightweight note and emits NO park", async () => {
  const { deps, parks, logged } = fakeDeps();
  const res = await runReflect(
    { ...baseOpts, isMilestone: false, proposedUpdate: "would-be brief change" },
    deps,
  );
  expect(parks).toHaveLength(0);
  expect(res.parked).toBe(false);
  expect(res.suppressedReason).toBe("not-a-milestone");
  // The lightweight note carries learned/onPath but NOT the proposal (stripped on the non-milestone path).
  expect(logged).toHaveLength(1);
  expect(logged[0].proposedUpdate).toBeUndefined();
  expect(logged[0].learned).toEqual(["the seam stayed pure"]);
});

test("explicit milestone with a proposal stages a SINGLE park (prose + conventions + glossary BATCHED)", async () => {
  const { deps, parks } = fakeDeps();
  const res = await runReflect(
    {
      ...baseOpts,
      isMilestone: true,
      proposedUpdate: "tighten the scope line",
      proposedConventions: ["land via the green gate", "ISO dates"],
      proposedGlossary: [
        { term: "park", means: "stage a question, keep going" },
        { term: "drain", means: "build the queue" },
      ],
    },
    deps,
  );
  expect(res.parked).toBe(true);
  // ONE park entry for the whole batch — NOT one per term/convention (spec 5.5).
  expect(parks).toHaveLength(1);
  expect(parks[0].title).toBe(BRIEF_UPDATE_PARK_TITLE);
  // All deltas are folded into the single reason.
  expect(parks[0].reason).toContain("tighten the scope line");
  expect(parks[0].reason).toContain("land via the green gate");
  expect(parks[0].reason).toContain("park=stage a question, keep going");
  expect(parks[0].reason).toContain("drain=build the queue");
});

test("milestone with NOTHING proposed logs but does not park", async () => {
  const { deps, parks, logged } = fakeDeps();
  const res = await runReflect({ ...baseOpts, isMilestone: true }, deps);
  expect(parks).toHaveLength(0);
  expect(res.parked).toBe(false);
  expect(res.suppressedReason).toBe("nothing-proposed");
  expect(logged).toHaveLength(1);
});

test("RATE-LIMIT: a second milestone proposal is suppressed while one is already parked", async () => {
  // A queue that already carries the brief-update park entry.
  const queueWithPark = `# Queue

- [ ] ${BRIEF_UPDATE_PARK_TITLE} @parked (a prior proposal awaiting review)
  Goal: hold for human
  Territory: -
  Done-when: human acts
`;
  const { deps, parks } = fakeDeps({ readQueue: async () => queueWithPark });
  const res = await runReflect(
    { ...baseOpts, isMilestone: true, proposedUpdate: "another change" },
    deps,
  );
  expect(parks).toHaveLength(0);
  expect(res.parked).toBe(false);
  expect(res.suppressedReason).toBe("already-parked");
});

test("rate-limit does NOT fire when the only parked item is an UNRELATED park", async () => {
  const queueWithOtherPark = `# Queue

- [ ] some other thing @parked (needs your call)
  Goal: x
  Territory: -
  Done-when: y
`;
  const { deps, parks } = fakeDeps({ readQueue: async () => queueWithOtherPark });
  const res = await runReflect(
    { ...baseOpts, isMilestone: true, proposedUpdate: "a real change" },
    deps,
  );
  expect(res.parked).toBe(true);
  expect(parks).toHaveLength(1);
});

// --- The no-write rail through the REAL appendReflection + a real emitPark fake, end-to-end. ---

test("RAIL: runReflect with the real appendReflection writes the LOG + park only — never brief.ts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reflect-e2e-"));
  const logPath = join(dir, "run-log.md");
  const briefPath = join(dir, "brief.ts");
  const queuePath = join(dir, "queue.md");
  writeFileSync(queuePath, "# Queue\n", "utf8");

  // Spy the global writers (record targets, delegate to the real impl so the log really lands).
  const targets: string[] = [];
  const origBunWrite = Bun.write.bind(Bun);
  const origFsWrite = fs.writeFileSync;
  const bunSpy = spyOn(Bun, "write").mockImplementation((dest: unknown, ...rest: unknown[]) => {
    targets.push(typeof dest === "string" ? dest : String((dest as { name?: string })?.name ?? dest));
    // @ts-expect-error delegate
    return origBunWrite(dest, ...rest);
  });
  const fsSpy = spyOn(fs, "writeFileSync").mockImplementation((p: unknown, ...rest: unknown[]) => {
    targets.push(String(p));
    // @ts-expect-error delegate
    return origFsWrite(p, ...rest);
  });

  const parkReasons: string[] = [];
  try {
    await runReflect(
      {
        ...baseOpts,
        logPath,
        queuePath,
        isMilestone: true,
        proposedUpdate: "narrow scope",
        proposedConventions: ["green gate only"],
        proposedGlossary: [{ term: "x", means: "y" }],
      },
      {
        appendReflection, // the REAL writer — proves it only touches logPath
        emitPark: async (_t, reason) => {
          parkReasons.push(reason);
        },
        readQueue: async (qp) => (existsSync(qp) ? fs.readFileSync(qp, "utf8") : ""),
      },
    );
  } finally {
    bunSpy.mockRestore();
    fsSpy.mockRestore();
  }

  expect(targets.some((t) => t.endsWith("run-log.md"))).toBe(true);
  expect(targets.some((t) => t.endsWith("brief.ts"))).toBe(false);
  expect(existsSync(briefPath)).toBe(false);
  // The proposal reached the human-gate as data, batched.
  expect(parkReasons).toHaveLength(1);
  expect(parkReasons[0]).toContain("narrow scope");
  expect(parkReasons[0]).toContain("green gate only");
  rmSync(dir, { recursive: true, force: true });
});

// --- END-TO-END through the REAL emitPark (park.ts) — the proposal must actually REACH the
//     human-gate at runtime: an @parked line in queue.md + a `## Parked` line in NOW.md. The
//     earlier tests substitute a fake emitPark; this exercises the real parkItem semantics
//     (which only flip an EXISTING item) against a real on-disk queue.md, and proves the
//     rate-limit fires end-to-end against that real prior park. ---

test("E2E: a milestone proposal actually lands @parked in queue.md + `## Parked` in NOW.md", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reflect-park-e2e-"));
  const logPath = join(dir, "run-log.md");
  const queuePath = join(dir, "queue.md");
  const nowPath = join(dir, "NOW.md");
  // A queue with a header but NO item titled BRIEF_UPDATE_PARK_TITLE — the proposal was never enqueued.
  writeFileSync(queuePath, "# build queue\n", "utf8");
  writeFileSync(nowPath, "---\ncreated: 2026-06-08\n---\n\n# Now\n\nbody.\n", "utf8");

  // The REAL human-gate closure (mirrors cli.ts emitParkFor: emitPark across queue.md + NOW.md).
  const realEmitPark = async (title: string, reason: string) => {
    await emitPark(title, reason, { queuePath, nowPath });
  };
  const readQueue = async (qp: string) => (existsSync(qp) ? fs.readFileSync(qp, "utf8") : "");

  const res = await runReflect(
    {
      ...baseOpts,
      logPath,
      queuePath,
      isMilestone: true,
      proposedUpdate: "narrow inScopeSurfaces to tools",
      proposedConventions: ["land via the green gate"],
    },
    { appendReflection, emitPark: realEmitPark, readQueue },
  );
  expect(res.parked).toBe(true);

  // queue.md: the proposal is a real @parked item (NOT silently lost).
  const parked = parseQueue(fs.readFileSync(queuePath, "utf8")).find((i) => i.title === BRIEF_UPDATE_PARK_TITLE);
  expect(parked?.status).toBe("parked");
  expect(parked?.parkReason).toContain("narrow inScopeSurfaces to tools");
  expect(parked?.parkReason).toContain("land via the green gate");

  // NOW.md: the `## Parked — needs your call` section surfaces it.
  const nowText = fs.readFileSync(nowPath, "utf8");
  expect(nowText).toContain("## Parked — needs your call");
  expect(nowText).toContain(`- ${BRIEF_UPDATE_PARK_TITLE} —`);

  // RATE-LIMIT, end-to-end: a SECOND proposal is suppressed because the real on-disk queue now
  // carries the prior @parked brief-update item (isAlreadyParked observes it). No new park lands.
  const res2 = await runReflect(
    { ...baseOpts, logPath, queuePath, isMilestone: true, proposedUpdate: "a second change" },
    { appendReflection, emitPark: realEmitPark, readQueue },
  );
  expect(res2.parked).toBe(false);
  expect(res2.suppressedReason).toBe("already-parked");
  // Still exactly ONE brief-update item on disk (no duplicate, no second park).
  const matches = parseQueue(fs.readFileSync(queuePath, "utf8")).filter((i) => i.title === BRIEF_UPDATE_PARK_TITLE);
  expect(matches).toHaveLength(1);

  rmSync(dir, { recursive: true, force: true });
});
