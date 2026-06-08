import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfirmedBrief, renderBriefModule } from "../brief-writer";
import { DesignBriefSchema, type DesignBrief } from "../engine/brief";
import { loadBrief } from "../engine/load-brief";

function full(over: Record<string, unknown> = {}): DesignBrief {
  return DesignBriefSchema.parse({
    confirmed: true, purpose: "ship widgets", whyNow: "", whoServed: "owners", scope: "the widget core", limits: "no billing",
    conventions: ["npm"], glossary: [{ term: "Widget", means: "a thing" }], gaps: ["stale"],
    successCriteria: [{ id: "tests", statement: "tests pass", check: { kind: "command", run: "bun test" }, required: true }],
    ...over,
  });
}

test("writeConfirmedBrief writes a file that round-trips through loadBrief to status:ok", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bw-"));
  const path = join(dir, "brief.ts");
  writeConfirmedBrief(full(), path);
  const loaded = await loadBrief(path);
  expect(loaded.status).toBe("ok");
  expect(loaded.brief?.confirmed).toBe(true);
  expect(loaded.brief?.purpose).toBe("ship widgets");
  rmSync(dir, { recursive: true, force: true });
});

test("writeConfirmedBrief recomputes gaps via gapsOf (ignores caller's stale gaps)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bw-"));
  const path = join(dir, "brief.ts");
  writeConfirmedBrief(full({ gaps: ["WRONG", "STALE"] }), path); // caller's gaps are stale
  const loaded = await loadBrief(path);
  expect(loaded.brief?.gaps).not.toContain("WRONG"); // recomputed: a complete brief has no gaps
  expect(loaded.brief?.gaps).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test("renderBriefModule is pure (same input → same output)", () => {
  const b = full();
  expect(renderBriefModule(b)).toBe(renderBriefModule(b));
});
