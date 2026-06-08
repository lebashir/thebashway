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

import { parseBriefWritePayload } from "../brief-writer";

test("parseBriefWritePayload rejects malformed JSON", () => {
  const r = parseBriefWritePayload("{ not json");
  expect(r.ok).toBe(false);
});

test("parseBriefWritePayload rejects a schema-invalid payload (no required command criterion)", () => {
  const r = parseBriefWritePayload(JSON.stringify({
    purpose: "p", whyNow: "", whoServed: "w", scope: "s", limits: "l",
    successCriteria: [{ id: "v", statement: "verify", check: { kind: "verify" }, required: true }],
  }));
  expect(r.ok).toBe(false);
});

test("parseBriefWritePayload allows a partial draft (confirmed:false, empty core)", () => {
  const r = parseBriefWritePayload(JSON.stringify({
    confirmed: false, purpose: "", whyNow: "", whoServed: "", scope: "", limits: "",
    successCriteria: [{ id: "c", statement: "s", check: { kind: "command", run: "echo REPLACE-ME && exit 1" }, required: true }],
  }));
  expect(r.ok).toBe(true);
});

test("parseBriefWritePayload REFUSES confirmed:true while a Ring-1 core field is empty", () => {
  const r = parseBriefWritePayload(JSON.stringify({
    confirmed: true, purpose: "p", whyNow: "", whoServed: "", scope: "s", limits: "l",
    successCriteria: [{ id: "c", statement: "s", check: { kind: "command", run: "bun test" }, required: true }],
  }));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.join(" ")).toMatch(/who it's for/i);
});

test("parseBriefWritePayload ALLOWS confirmed:true with the deferred success placeholder", () => {
  const r = parseBriefWritePayload(JSON.stringify({
    confirmed: true, purpose: "p", whyNow: "", whoServed: "w", scope: "s", limits: "l",
    successCriteria: [{ id: "c", statement: "s", check: { kind: "command", run: "echo REPLACE-ME && exit 1" }, required: true }],
  }));
  expect(r.ok).toBe(true);
});

import { briefGateDecision } from "../brief-writer";

test("gate passes when requireBrief is off, or skipped, or confirmed", () => {
  expect(briefGateDecision({ status: "absent", confirmed: false, requireBrief: false, skipBrief: false }).pass).toBe(true);
  expect(briefGateDecision({ status: "absent", confirmed: false, requireBrief: true, skipBrief: true }).pass).toBe(true);
  expect(briefGateDecision({ status: "ok", confirmed: true, requireBrief: true, skipBrief: false }).pass).toBe(true);
});

test("gate stops with a guided message when no confirmed brief", () => {
  const absent = briefGateDecision({ status: "absent", confirmed: false, requireBrief: true, skipBrief: false });
  expect(absent.pass).toBe(false);
  expect(absent.message).toMatch(/north star isn.t set up/i);

  const draft = briefGateDecision({
    status: "ok", confirmed: false, requireBrief: true, skipBrief: false,
    readiness: { gaps: ["scope", "success check"], coreComplete: false, autonomousReady: false, confirmed: false },
  });
  expect(draft.pass).toBe(false);
  expect(draft.message).toMatch(/in progress/i);
  expect(draft.message).toMatch(/scope/);
});

test("gate surfaces the unparseable loud signal", () => {
  const r = briefGateDecision({ status: "unparseable", confirmed: false, requireBrief: true, skipBrief: false });
  expect(r.pass).toBe(false);
  expect(r.message).toMatch(/does not parse/i);
});

import { briefStatusLines } from "../brief-writer";

test("briefStatusLines: confirmed + ready → 'you're set'", () => {
  const lines = briefStatusLines({ gaps: [], coreComplete: true, autonomousReady: true, confirmed: true }).join("\n");
  expect(lines).toMatch(/confirmed/i);
  expect(lines).toMatch(/set/i);
});
test("briefStatusLines: draft → shows remaining gaps + the next step", () => {
  const lines = briefStatusLines({ gaps: ["scope", "success check"], coreComplete: false, autonomousReady: false, confirmed: false }).join("\n");
  expect(lines).toMatch(/draft/i);
  expect(lines).toMatch(/scope/);
  expect(lines).toMatch(/interview/i);
});
