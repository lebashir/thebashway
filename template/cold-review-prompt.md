# Cold-review prompt — template

A reviewing basha runs this prompt with the slots below filled in by the
driver. It is project-agnostic; a project may keep its own
`<orchestrator-dir>/cold-review-prompt.md` with an addendum block appended
(surface map, key conventions, schema notes).

The reviewer NEVER self-validates the verify manifest. The driver
recomputes its hashes against git first and provides the already-trusted
version as `<verify-manifest>`.

---

## Cold review — {{UNIT_TITLE}}

### FIDELITY PREAMBLE (read first — do NOT skip)

You are reviewing with limited context. Several gaps are KNOWN and you
MUST account for them:

- **DB migrations may be applied via Supabase MCP and not committed as
  SQL files.** The diff is the source for code; `list_migrations` output
  (provided below) is the source for schema. Do NOT flag "missing
  migration" or "no DDL in diff" unless `list_migrations` confirms the
  migration is absent.
- **Probes that grep rendered text must match the LITERAL `textContent`.**
  Case is preserved (CSS `text-transform: uppercase` does NOT change
  textContent); substring traps lie (`/invalid/` does NOT match "Enter a
  valid amount." — `invalid` is not a substring of `valid`); partial
  matches lie. If you suspect a probe-driven finding, restate the exact
  expected substring and the exact rendered string before flagging.
- **Interactive shape = what a USER actually sees.** A `<button>` without
  an `onClick` handler is still announced as a button by screen readers
  and is still a tab stop. Render `<div>` when there is no handler;
  reserve `<button>` for things that DO something. Cursor styling does
  not change AT-semantics.
- **The user's existing schema may already cover what looks new.** Cross-
  check live state (`list_tables` / `list_columns`) before flagging
  "duplicate column" or "near-duplicate table". `create table if not
  exists` silently no-ops on a pre-existing table.
- **Your suggested fix can be wrong.** Judge each against actual
  behavior. If a synthetic event dispatch looks like a "loop risk,"
  verify it isn't load-bearing (e.g. same-tab `useSyncExternalStore`
  resync — the native `storage` event only fires in OTHER tabs) before
  suggesting removal. If unsure, mark the finding as MINOR with an
  explicit "verify with the author" note rather than CRITICAL.

### INPUTS

- **Spec** (the unit must satisfy this): {{SPEC}}
- **Diff** (git show / git diff --stat + per-file diffs): {{DIFF}}
- **Verify manifest** (driver pre-validated, hashes match git):
  {{VERIFY_MANIFEST}}
- **Live DB migrations** (`list_migrations` output — schema source of truth):
  {{LIST_MIGRATIONS}}
- **Project context** (surface map, key conventions, project-specific
  pitfalls):
  {{PROJECT_ADDENDUM}}

### YOUR JOB

Walk the diff. For each finding, classify as one of:

- **`INLINE-FIX`** — ≤30 lines, single file, no public-API change, no
  spec deviation. The driver will patch in the worktree, re-verify, and
  proceed. Example: missing `aria-label`, off-by-one in a clamp, wrong
  copy in an error message.
- **`STRUCTURAL`** — multi-file, public-API change, spec deviation,
  behavior inversion, missing migration confirmed by `list_migrations`,
  data-shape mismatch. The basha will retry with this feedback (retry
  budget: 1; then the item parks).

Output format:

```
VERDICT: MERGE | MERGE-WITH-FIXES | BOUNCE

## INLINE-FIX (driver patches)
- <file:line> — <finding> — <suggested patch in 1-3 lines>

## STRUCTURAL (basha retries)
- <file:line> — <finding> — <why structural>

## QUESTIONS-FOR-AUTHOR (only if you genuinely can't decide)
- <one-line question>
```

Verdicts:
- `MERGE` — no findings; ship as is.
- `MERGE-WITH-FIXES` — `INLINE-FIX` only; driver applies and ships.
- `BOUNCE` — any `STRUCTURAL` finding.

Default to inline-fixing in spirit: if you're unsure whether it's
inline-or-structural, prefer `INLINE-FIX` and let the driver judge.
