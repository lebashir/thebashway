// tools/orchestrator/territory.ts
// Conservative territory-overlap test for the multi-session claim guard.
// Two territories overlap if any glob in A and any glob in B could match a
// common path. We approximate by reducing each glob to its static directory
// prefix and testing segment-aware path-prefix containment. Bias: false
// positives (over-report overlap) only cost parallelism; false negatives could
// cause a real cross-session collision, so an empty prefix (e.g. "**") overlaps
// everything.

/** Reduce a glob to the static path before its first wildcard. */
export function globPrefix(glob: string): string {
  const star = glob.search(/[*?\[]/);
  const head = star === -1 ? glob : glob.slice(0, star);
  return head.replace(/\/+$/, ""); // trim trailing slash
}

/** True if `p` equals `of` or is a segment-aware path prefix of `of`. */
function isPathPrefix(p: string, of: string): boolean {
  if (p === of) return true;
  return of.startsWith(p + "/");
}

export function territoriesOverlap(a: string[], b: string[]): boolean {
  for (const ga of a) {
    const pa = globPrefix(ga);
    for (const gb of b) {
      const pb = globPrefix(gb);
      if (pa === "" || pb === "") return true; // a bare ** matches everything
      if (pa === pb || isPathPrefix(pa, pb) || isPathPrefix(pb, pa)) return true;
    }
  }
  return false;
}
