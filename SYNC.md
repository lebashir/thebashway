# How this package relates to lifeofbash

This package's engine (`src/engine/`) was **extracted from**
`lifeofbash/tools/orchestrator` and then **generalized** — the lifeofbash-specific
config was lifted out into a `ProjectBinding` (`src/binding.ts`), so the files here
intentionally differ from the originals. lifeofbash still runs its own copy.

## The drift risk

Because there are now two copies, lifeofbash's engine can move ahead (a bug fix, a new
capability) and this package can fall behind — that is exactly how the *previous*
extraction went stale. v1 does not auto-sync; it makes drift **visible**:

```
bun run check-sync
```

`.sync-ref` records the lifeofbash commit this package was last reconciled to.
`check-sync` lists the commits that have touched `tools/orchestrator` in lifeofbash
since then — i.e. the changes that may need porting here. When you reconcile, update
`.sync-ref` to the new lifeofbash HEAD.

## The permanent fix (next spec, not v1)

Make lifeofbash a **consumer** of this package: its `tools/orchestrator` shrinks to a
binding (`thebashway.config.ts`) + a thin CLI wrapper, importing the engine from here.
One copy, no drift. That refactor is deliberately deferred so v1 stays a clean, low-risk
extraction — see `docs/superpowers/specs/2026-06-05-thebashway-portable-build-fix-design.md`
§9 in the lifeofbash repo.
