// tools/orchestrator/basha-prompt.ts
// Assembles a complete basha prompt with both lesson blocks:
//   1. "Standing substrate rules" — from memory/operating-lessons.md
//      (cross-cutting guardrails; always meta/hygiene/zone/infra/cost by default)
//   2. "Known pitfalls — do not repeat" — from tools/orchestrator/lessons.md
//      (build-loop-specific; filtered per basha area/surface)
//   3. taskBody — the actual task instructions
//
// The driver calls this instead of manually assembling both blocks.
// See tools/orchestrator/thebashway/SKILL.md § Lessons.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { formatForPrompt, relevantLessons, readLessons } from "./lessons";
import type { Lesson as OrchestratorLesson } from "./lessons";
import { parseLessons } from "./operating-lessons";
import type { Lesson as OperatingLesson } from "./operating-lessons";

// Default area filter for cross-cutting guardrails injected into every basha.
// Does NOT include people/self/* — those are never injected into build-zone prompts.
export const DEFAULT_OPERATING_AREAS = ["meta", "hygiene", "zone", "infra", "cost"] as const;

export interface BuildBashaPromptOptions {
  /** Active lessons from memory/operating-lessons.md (all of them; filtering happens here). */
  operatingLessons: OperatingLesson[];
  /** Active lessons from tools/orchestrator/lessons.md (pre-filtered by caller via relevantLessons). */
  buildLessons: OrchestratorLesson[];
  /** The task body / instructions text. */
  taskBody: string;
  /** Operating areas to inject. Defaults to DEFAULT_OPERATING_AREAS. */
  operatingAreas?: string[];
}

function formatOperatingBlock(lessons: OperatingLesson[], areas: readonly string[]): string {
  const areaSet = new Set(areas.map((a) => a.toLowerCase()));
  const filtered = lessons.filter((l) => l.areas.some((a) => areaSet.has(a.toLowerCase())));
  if (filtered.length === 0) return "";
  const bullets = filtered.map((l) => `- ${l.areas.map((a) => `[${a}]`).join(" ")} ${l.body}`).join("\n");
  return `Standing substrate rules — honor these as hard constraints:\n${bullets}`;
}

export function buildBashaPrompt(opts: BuildBashaPromptOptions): string {
  const {
    operatingLessons,
    buildLessons,
    taskBody,
    operatingAreas = DEFAULT_OPERATING_AREAS,
  } = opts;

  const parts: string[] = [];

  const substrateBlock = formatOperatingBlock(operatingLessons, operatingAreas);
  if (substrateBlock) parts.push(substrateBlock);

  const buildBlock = formatForPrompt(buildLessons);
  if (buildBlock) parts.push(buildBlock);

  if (taskBody) parts.push(taskBody);

  return parts.join("\n\n");
}

// Convenience: read both lesson files from disk and return a ready prompt.
// The driver may use this, or may call buildBashaPrompt directly with pre-loaded lessons.
export async function buildBashaPromptFromDisk(opts: {
  repoRoot: string;
  lessonsPath: string;       // path to the LOCAL build lessons (binding.learning.local)
  taskBody: string;
  buildAreas?: string[];     // areas for relevantLessons() filtering
  operatingAreas?: string[]; // areas for operating-lessons filtering
  // The GLOBAL operating-lessons store (binding.learning.global). Hybrid learning:
  //   undefined → default to <repoRoot>/memory/operating-lessons.md (lifeofbash back-compat)
  //   null      → no global store (a bare repo); use local build lessons only
  //   string    → read the shared cross-project store at this path
  operatingLessonsPath?: string | null;
}): Promise<string> {
  const { repoRoot, lessonsPath, taskBody, buildAreas = [], operatingAreas, operatingLessonsPath } = opts;

  // Read operating lessons (the global store).
  const ledgerPath =
    operatingLessonsPath === undefined
      ? join(repoRoot, "memory", "operating-lessons.md")
      : operatingLessonsPath;
  const operatingLessons =
    ledgerPath && existsSync(ledgerPath)
      ? parseLessons(readFileSync(ledgerPath, "utf8")).active
      : [];

  // Read build-loop lessons.
  const allBuildLessons = await readLessons(lessonsPath);
  const buildLessons = relevantLessons(allBuildLessons, ["general", ...buildAreas]);

  return buildBashaPrompt({ operatingLessons, buildLessons, taskBody, operatingAreas });
}
