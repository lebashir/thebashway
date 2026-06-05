// src/router.ts
// The mode router. A bare `thebashway "<request>"` is classified into Build Mode
// (create something NEW → the design door) or Fix Mode (repair/audit/clean up
// EXISTING behavior → the audit door). Explicit `build` / `fix` subcommands skip
// this. Cheap heuristic first; an LLM call only resolves genuine ambiguity.

import { runClaude, type HeadlessOptions, type HeadlessResult } from "./engine/headless";

export type Mode = "build" | "fix";

const BUILD_RE =
  /\b(build|builds|building|add|adds|adding|create|creates|creating|implement|implements|implementing|introduce|introduces|scaffold|generate|new feature|support for|set up|sets up)\b/i;
const FIX_RE =
  /\b(fix|fixes|fixing|fixed|broke|broken|bug|bugs|buggy|audit|audits|clean ?up|cleanup|refactor|refactors|refactoring|repair|repairs|wrong|failing|fails|crash|crashes|crashing|error|errors|regression|regressions|tidy|misbehav|not working)\b/i;

/** Deterministic classification; null when the request gives both signals or neither. */
export function classifyModeHeuristic(request: string): Mode | null {
  const isBuild = BUILD_RE.test(request);
  const isFix = FIX_RE.test(request);
  if (isBuild && !isFix) return "build";
  if (isFix && !isBuild) return "fix";
  return null;
}

export interface ClassifyModeDeps {
  runClaude: (opts: HeadlessOptions) => Promise<HeadlessResult>;
  cwd: string;
}

/**
 * Classify a request into a mode. Tries the heuristic first; only an ambiguous
 * request (both or neither signal) costs a cheap LLM call. Defaults to "fix" when
 * the LLM is unavailable — Fix only audits/changes existing code, whereas Build
 * creates new code, so Fix is the safer wrong-guess.
 */
export async function classifyMode(request: string, deps: ClassifyModeDeps): Promise<Mode> {
  const heuristic = classifyModeHeuristic(request);
  if (heuristic) return heuristic;

  const prompt =
    `You are a router. Classify the software request below as exactly one word:\n` +
    `"build" = create a NEW feature or capability that does not exist yet.\n` +
    `"fix"   = repair, audit, clean up, or change EXISTING behavior.\n\n` +
    `Request: ${JSON.stringify(request)}\n\n` +
    `Reply with only the single word: build or fix.`;

  try {
    const res = await deps.runClaude({ prompt, cwd: deps.cwd });
    const out = (res.stdout || "").toLowerCase();
    const saysBuild = /\bbuild\b/.test(out);
    const saysFix = /\bfix\b/.test(out);
    if (saysBuild && !saysFix) return "build";
    if (saysFix && !saysBuild) return "fix";
  } catch {
    // fall through to the safe default
  }
  return "fix";
}

export function defaultClassifyModeDeps(cwd: string): ClassifyModeDeps {
  return { runClaude, cwd };
}
