// src/brief-writer.ts
// The human-present brief-command layer. INV-A: writeConfirmedBrief is the SECOND of the two
// sanctioned writers (the first is init.ts's seedBriefIfAbsent). The engine's brief.ts exports
// no writer; this is the only non-init writeFileSync(briefPath) in the codebase.
import { writeFileSync } from "node:fs";
import { gapsOf, type DesignBrief } from "./engine/brief";
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
