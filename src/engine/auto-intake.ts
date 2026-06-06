// tools/orchestrator/auto-intake.ts
// Stage 2 auto-intake scaffolding (the read side). The deterministic helpers list the
// @needs-intake items and assemble each one's Loop A intake prompt; the *judgment*
// (promote with `mark-ready` vs. defer with `intake-defer`) is conservative and lives
// in the SKILL protocol — promote only what's high-confidence-resolvable from the
// decision store + the codebase; leave the rest @needs-intake with an Open-question.
// See docs/superpowers/plans/2026-06-04-thebashway-stage2-auto-capture.md.
import { parseQueue, type QueueItem } from "./queue";
import { globPrefix } from "./territory";
import { readLessons } from "./lessons";
import { buildIntakePrompt } from "./intake-prompt";

/** `a` contains or is contained by `b` as a path (segment-aware). */
function dirContains(a: string, b: string): boolean {
  return a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
}

/**
 * Map an item's territory globs to configured surface names (for Loop A's two-tier
 * area selection). Reuses `globPrefix` (territory.ts) — no hand-rolled glob parsing.
 * A bare `**` territory has an empty prefix and maps to ALL surfaces (harmless
 * over-injection of decision rules). A non-surface path (e.g. `NOW.md`) maps to none.
 */
export function areasForItem(
  item: Pick<QueueItem, "territory">,
  surfaces: Record<string, { dir: string }>,
): string[] {
  const areas = new Set<string>();
  for (const glob of item.territory) {
    const prefix = globPrefix(glob);
    for (const [name, cfg] of Object.entries(surfaces)) {
      if (prefix === "") { areas.add(name); continue; } // bare ** → every surface
      if (dirContains(cfg.dir, prefix)) areas.add(name);
    }
  }
  return [...areas];
}

/** The per-item intake task body that rides under the Loop A decision block. */
export function intakeTaskBody(item: QueueItem): string {
  const lines = [
    "Intake this @needs-intake item to build-ready. Fill Goal / Territory / Done-when by",
    "reading the codebase + the decision defaults above. Promote with `bun run thebashway",
    "mark-ready \"<title>\"` ONLY if high-confidence; otherwise record the blocker with",
    "`bun run thebashway intake-defer \"<title>\" \"<question>\"` and leave it for Bashir.",
    "",
    `Title: ${item.title}`,
    `Goal: ${item.goal || "(empty — derive it)"}`,
    `Territory: ${item.territory.length ? item.territory.join(", ") : "(none — derive it)"}`,
    `Source: ${item.source ?? "(human capture)"}`,
    `Open-question (prior defer): ${item.openQuestion ?? "none"}`,
  ];
  return lines.join("\n");
}

export interface IntakeCandidate {
  item: QueueItem;
  areas: string[];
  intakePrompt: string;
}

/** List every @needs-intake item with its areas + assembled Loop A intake prompt. */
export async function listIntakeCandidates(opts: {
  queuePath: string;
  decisionsPath: string;
  surfaces: Record<string, { dir: string }>;
}): Promise<IntakeCandidate[]> {
  const items = parseQueue(await Bun.file(opts.queuePath).text()).filter(
    (i) => i.status === "needs-intake",
  );
  const decisionLessons = await readLessons(opts.decisionsPath);
  return items.map((item) => {
    const areas = areasForItem(item, opts.surfaces);
    return {
      item,
      areas,
      intakePrompt: buildIntakePrompt({ decisionLessons, itemAreas: areas, taskBody: intakeTaskBody(item) }),
    };
  });
}

/** One-line surface for stdout / the driver to relay: what promoted, what needs Bashir. */
export function summarizeIntake(
  promoted: string[],
  deferred: { title: string; question: string }[],
): string {
  const parts = [`auto-intake: promoted ${promoted.length}`];
  if (deferred.length) {
    parts.push(`${deferred.length} need input: ${deferred.map((d) => d.title).join("; ")}`);
  }
  return parts.join("; ");
}
