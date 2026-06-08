// src/engine/load-brief.ts
// The thin IO wrapper that loads a brief.ts module from disk — kept OUT of the pure brief.ts
// (which has no fs/spawn and no writer, per INV-A). loadBrief dynamic-import()s the module
// exactly as loadBinding loads thebashway.config.ts (INV-B), then DesignBriefSchema.safeParse.
//
// Parse-failure contract (spec 3.1, load-bearing): a brief file that EXISTS but fails to
// import OR safeParse must NOT silently degrade to "no brief" — it returns status:'unparseable'
// with errors populated. status:'absent' is the ONLY benign "no brief" state (the file does
// not exist). loadBrief itself does NOT emit the park — it returns the status; the CALLER emits
// the loud signal. This wrapper exports no brief writer either.
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DesignBriefSchema, type DesignBrief } from "./brief";

export interface LoadBriefResult {
  brief: DesignBrief | null;
  status: "ok" | "absent" | "unparseable";
  errors: string[];
}

/**
 * Load and validate the brief at `briefPath`.
 * - file missing            => { brief: null, status: 'absent', errors: [] }
 * - exists but import throws => { brief: null, status: 'unparseable', errors: [<message>] }
 * - exists but safeParse !ok => { brief: null, status: 'unparseable', errors: [<issues>] }
 * - exists and valid         => { brief, status: 'ok', errors: [] }
 */
export async function loadBrief(briefPath: string): Promise<LoadBriefResult> {
  if (!existsSync(briefPath)) {
    return { brief: null, status: "absent", errors: [] };
  }

  let mod: { default?: unknown; brief?: unknown };
  try {
    // cache-bust so the brief is loaded fresh each run (e.g. across runToGoal iterations),
    // mirroring the dynamic-import() loadBinding uses for the config.
    const url = `${pathToFileURL(briefPath).href}?t=${Date.now()}`;
    mod = await import(url);
  } catch (err) {
    return {
      brief: null,
      status: "unparseable",
      errors: [`brief import failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const exported = mod.default ?? mod.brief;
  const parsed = DesignBriefSchema.safeParse(exported);
  if (!parsed.success) {
    return {
      brief: null,
      status: "unparseable",
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
    };
  }

  return { brief: parsed.data, status: "ok", errors: [] };
}
