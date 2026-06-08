// src/brief-writer.ts
// The human-present brief-command layer. INV-A: writeConfirmedBrief is the SECOND of the two
// sanctioned writers (the first is init.ts's seedBriefIfAbsent). The engine's brief.ts exports
// no writer; this is the only non-init writeFileSync(briefPath) in the codebase.
import { writeFileSync } from "node:fs";
import { gapsOf, DesignBriefSchema, type DesignBrief, type BriefReadiness } from "./engine/brief";
import { briefModule } from "./init";

/** Pure render of a confirmed DesignBrief to a clean, re-readable brief.ts module. */
export function renderBriefModule(brief: DesignBrief): string {
  // gaps are recomputed canonically (never trust a caller's stale list).
  const fields = { ...brief, gaps: gapsOf(brief).gaps };
  return briefModule(fields);
}

/** The human-present write. Renders + writes; recomputes gaps via gapsOf. */
export function writeConfirmedBrief(brief: DesignBrief, briefPath: string): void {
  writeFileSync(briefPath, renderBriefModule(brief), "utf8");
}

export type BriefWriteParse =
  | { ok: true; brief: DesignBrief }
  | { ok: false; errors: string[] };

/** Parse + validate a `brief write` JSON payload at the boundary. Rejects malformed JSON, a
 * schema-invalid brief, and a premature confirm (confirmed:true while a Ring-1 core field is empty).
 * The deferred success-command placeholder is the ONE gap allowed under confirmed:true. */
export function parseBriefWritePayload(raw: string): BriefWriteParse {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: [`payload is not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const parsed = DesignBriefSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const brief = parsed.data;
  if (brief.confirmed) {
    const readiness = gapsOf(brief);
    if (!readiness.coreComplete) {
      const missing = readiness.gaps.filter((g) => g !== "success check");
      return { ok: false, errors: [`cannot confirm — these core fields are still empty: ${missing.join(", ")}`] };
    }
  }
  return { ok: true, brief };
}

/** Pure brief-first gate decision. Given the brief's load status + readiness, decide whether a work
 * command may run, and the guided message to print otherwise. `requireBrief:false` or `--skip-brief`
 * always pass; a confirmed parseable brief passes; everything else stops with a plain-language nudge. */
export function briefGateDecision(opts: {
  status: "ok" | "absent" | "unparseable";
  confirmed: boolean;
  readiness?: BriefReadiness;
  requireBrief: boolean;
  skipBrief: boolean;
}): { pass: boolean; message?: string } {
  if (!opts.requireBrief || opts.skipBrief) return { pass: true };
  if (opts.status === "ok" && opts.confirmed) return { pass: true };
  if (opts.status === "unparseable") {
    return { pass: false, message: "Your north star file exists but does not parse — fix it before continuing (or pass --skip-brief)." };
  }
  if (opts.status === "ok" && !opts.confirmed) {
    const gaps = opts.readiness?.gaps ?? [];
    const left = gaps.length ? ` (still to do: ${gaps.join(", ")})` : "";
    return { pass: false, message: `Your north star is in progress${left}. Finish it first: thebashway brief. (Or pass --skip-brief.)` };
  }
  return { pass: false, message: "Your north star isn't set up yet — let's do that first: thebashway brief. (Or pass --skip-brief / set requireBrief:false.)" };
}
