// tools/test/audit.test.ts
// Unit tests for the directed-audit IN-door capability:
//   - resolveTarget: known registry, generic dir fallback, unknown-throws
//   - auditFingerprint: canonicalized (idempotent across cosmetic title/territory variants)
//   - enqueueFindings: dedup/idempotent re-run, status-honored build-ready vs needs-intake,
//                       freezeSafe:false forced to needs-intake, malformed-input zod-reject
import { describe, expect, test, beforeEach } from "bun:test";
import { z } from "zod";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  resolveTarget,
  auditFingerprint,
  AuditPlanSchema,
  CompletableItemSchema,
  type AuditPlan,
  type CompletableItem,
} from "../audit";
import { enqueueFindings } from "../queue-ops";
import { parseQueue } from "../queue";

// ---------------------------------------------------------------------------
// resolveTarget
// ---------------------------------------------------------------------------

describe("resolveTarget — known target", () => {
  test("resolves 'money' to the registry entry", () => {
    const plan = resolveTarget("money");
    expect(plan.surface).toBe("organs");
    expect(typeof plan.rootGlob).toBe("string");
    expect(plan.rootGlob).toContain("money");
    expect(Array.isArray(plan.subAreas)).toBe(true);
    expect(plan.subAreas.length).toBeGreaterThan(0);
  });

  test("resolves case-insensitively ('Money')", () => {
    const plan = resolveTarget("Money");
    expect(plan.surface).toBe("organs");
  });
});

describe("resolveTarget — generic dir-split fallback", () => {
  test("resolves a path/glob not in the registry", () => {
    // Any string that looks like a path but is not a registered key
    const plan = resolveTarget("organs/src/sections/people");
    expect(plan.surface).toBe("organs");
    expect(plan.subAreas.length).toBeGreaterThan(0);
  });

  test("caps subAreas at AUDIT_FANOUT_MAX", () => {
    // Even if a target explodes into many globs, must not exceed 10
    const plan = resolveTarget("organs/src");
    expect(plan.subAreas.length).toBeLessThanOrEqual(10);
  });
});

describe("resolveTarget — unknown target throws", () => {
  test("throws a clear error on empty string", () => {
    expect(() => resolveTarget("")).toThrow();
  });

  test("throws a clear error on a typo-like unknown key", () => {
    expect(() => resolveTarget("mnoy")).toThrow(/unknown.*target|cannot resolve/i);
  });

  test("error message names the target", () => {
    let msg = "";
    try {
      resolveTarget("definitely-not-a-target");
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain("definitely-not-a-target");
  });
});

// ---------------------------------------------------------------------------
// auditFingerprint — canonicalized
// ---------------------------------------------------------------------------

describe("auditFingerprint — idempotency across cosmetic variants", () => {
  const base: CompletableItem = {
    title: "Fix stale balance display",
    goal: "Balance never goes stale",
    territory: ["organs/src/sections/money/components/**"],
    doneWhen: "verify green",
    status: "unclaimed",
    freezeSafe: true,
  };

  test("same item produces the same fingerprint", () => {
    expect(auditFingerprint(base)).toBe(auditFingerprint(base));
  });

  test("title with different casing produces the same fingerprint", () => {
    const upper: CompletableItem = { ...base, title: "FIX STALE BALANCE DISPLAY" };
    expect(auditFingerprint(upper)).toBe(auditFingerprint(base));
  });

  test("title with extra whitespace produces the same fingerprint", () => {
    const spaced: CompletableItem = { ...base, title: "  Fix  stale   balance   display  " };
    expect(auditFingerprint(spaced)).toBe(auditFingerprint(base));
  });

  test("territory globs in different order produce the same fingerprint", () => {
    const reordered: CompletableItem = {
      ...base,
      territory: [
        "organs/src/sections/money/utils/**",
        "organs/src/sections/money/components/**",
      ],
    };
    const original: CompletableItem = {
      ...base,
      territory: [
        "organs/src/sections/money/components/**",
        "organs/src/sections/money/utils/**",
      ],
    };
    expect(auditFingerprint(reordered)).toBe(auditFingerprint(original));
  });

  test("territory globs with different casing produce the same fingerprint", () => {
    const upper: CompletableItem = {
      ...base,
      territory: ["Organs/src/sections/money/components/**"],
    };
    const lower: CompletableItem = {
      ...base,
      territory: ["organs/src/sections/money/components/**"],
    };
    expect(auditFingerprint(upper)).toBe(auditFingerprint(lower));
  });

  test("genuinely different title produces a different fingerprint", () => {
    const diff: CompletableItem = { ...base, title: "Completely different work" };
    expect(auditFingerprint(diff)).not.toBe(auditFingerprint(base));
  });

  test("fingerprint starts with 'audit:'", () => {
    expect(auditFingerprint(base)).toMatch(/^audit:/);
  });
});

// ---------------------------------------------------------------------------
// enqueueFindings
// ---------------------------------------------------------------------------

async function makeQueue(initial = ""): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tbw-test-"));
  const path = join(dir, "queue.md");
  const header = `# build queue\n\n${initial}`;
  await writeFile(path, header, "utf-8");
  return path;
}

const buildReadyItem: CompletableItem = {
  title: "Correct rounding in budget summary",
  goal: "Budget totals match actual values",
  territory: ["organs/src/sections/money/components/Budget*"],
  doneWhen: "verify green",
  status: "unclaimed",
  freezeSafe: true,
};

const needsIntakeItem: CompletableItem = {
  title: "Decide on new chart colour palette",
  goal: "Charts use brand colours",
  territory: ["organs/src/sections/money/components/Chart*"],
  doneWhen: "verify green",
  status: "needs-intake",
  openQuestion: "Which colour palette — brand or accessibility?",
  freezeSafe: true,
};

const freezeUnsafeItem: CompletableItem = {
  title: "Add new analytics dashboard page",
  goal: "Show spend analytics",
  territory: ["organs/src/sections/money/components/Analytics*"],
  doneWhen: "verify green",
  status: "unclaimed",
  freezeSafe: false, // new UI — must be forced to needs-intake
};

describe("enqueueFindings — basic enqueue", () => {
  test("enqueues a build-ready item as @unclaimed", async () => {
    const queuePath = await makeQueue();
    await enqueueFindings([buildReadyItem], queuePath);
    const items = parseQueue(await Bun.file(queuePath).text());
    const item = items.find((i) => i.title === buildReadyItem.title);
    expect(item).toBeDefined();
    expect(item!.status).toBe("unclaimed");
    expect(item!.origin).toBe("auto");
  });

  test("enqueues a needs-intake item with open question", async () => {
    const queuePath = await makeQueue();
    await enqueueFindings([needsIntakeItem], queuePath);
    const items = parseQueue(await Bun.file(queuePath).text());
    const item = items.find((i) => i.title === needsIntakeItem.title);
    expect(item).toBeDefined();
    expect(item!.status).toBe("needs-intake");
    expect(item!.openQuestion).toBe(needsIntakeItem.openQuestion);
    expect(item!.origin).toBe("auto");
  });
});

describe("enqueueFindings — freezeSafe:false forced to needs-intake", () => {
  test("freezeSafe:false item is written as @needs-intake regardless of requested status", async () => {
    const queuePath = await makeQueue();
    await enqueueFindings([freezeUnsafeItem], queuePath);
    const items = parseQueue(await Bun.file(queuePath).text());
    const item = items.find((i) => i.title === freezeUnsafeItem.title);
    expect(item).toBeDefined();
    expect(item!.status).toBe("needs-intake");
  });
});

describe("enqueueFindings — dedup / idempotent re-run", () => {
  test("re-running with the same items does not add duplicates", async () => {
    const queuePath = await makeQueue();
    await enqueueFindings([buildReadyItem], queuePath);
    const result = await enqueueFindings([buildReadyItem], queuePath);
    const items = parseQueue(await Bun.file(queuePath).text());
    const matching = items.filter((i) => i.title === buildReadyItem.title);
    expect(matching).toHaveLength(1);
    expect(result.skippedExisting).toHaveLength(1);
    expect(result.appended).toHaveLength(0);
  });

  test("dedup works across ALL statuses — a @done item blocks re-enqueue", async () => {
    const fp = auditFingerprint(buildReadyItem);
    // Pre-populate queue with a @done item that has the same fingerprint as our item
    const queuePath = await makeQueue(
      `- [x] ${buildReadyItem.title} (origin: auto)        @done\n  Goal: ${buildReadyItem.goal}\n  Territory: ${buildReadyItem.territory.join(", ")}\n  Done-when: ${buildReadyItem.doneWhen}\n  Source: ${fp}\n`
    );
    const result = await enqueueFindings([buildReadyItem], queuePath);
    expect(result.skippedExisting).toHaveLength(1);
    expect(result.appended).toHaveLength(0);
  });

  test("cosmetically different variant of the same item is deduped", async () => {
    const queuePath = await makeQueue();
    await enqueueFindings([buildReadyItem], queuePath);
    const variant: CompletableItem = {
      ...buildReadyItem,
      title: "  CORRECT ROUNDING IN BUDGET SUMMARY  ", // different casing + spaces
    };
    const result = await enqueueFindings([variant], queuePath);
    expect(result.skippedExisting).toHaveLength(1);
  });
});

describe("enqueueFindings — malformed input zod-rejection", () => {
  // enqueueFindings validates at the schema level; we exercise the schema directly
  // since the CLI parses the file, but the function itself accepts typed objects.
  // What we test: the CompletableItemSchema rejects bad data, so the CLI can reject
  // malformed JSON before calling enqueueFindings.

  test("CompletableItemSchema rejects missing required fields", () => {
    const bad = { title: "No territory or doneWhen" };
    expect(() => CompletableItemSchema.parse(bad)).toThrow();
  });

  test("CompletableItemSchema rejects invalid status", () => {
    const bad = {
      title: "Bad status",
      goal: "x",
      territory: ["a/**"],
      doneWhen: "done",
      status: "flying", // not a valid QueueStatus
      freezeSafe: true,
    };
    expect(() => CompletableItemSchema.parse(bad)).toThrow();
  });

  test("CompletableItemSchema accepts a valid item", () => {
    expect(() => CompletableItemSchema.parse(buildReadyItem)).not.toThrow();
  });

  test("array of CompletableItems is validatable", () => {
    const arr = [buildReadyItem, needsIntakeItem];
    expect(() => z.array(CompletableItemSchema).parse(arr)).not.toThrow();
  });
});
