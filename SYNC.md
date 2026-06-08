# How this package relates to lifeofbash

This package's engine (`src/engine/`) was **extracted from** `lifeofbash/tools/orchestrator`
and then **generalized** behind an injected `ProjectBinding` (`src/binding.ts`). As of
**2026-06-08, lifeofbash CONSUMES this package** — its `tools/orchestrator/` shrank to a binding
(`thebashway.config.ts`) plus its data/learning stores, and the engine, CLI, verify gate, granular
driver verbs, and build-method skill all come from here (linked with `bun link`).

## One copy, no drift

The old two-copy drift risk is gone, so the `check-sync` command and `.sync-ref` tracker have been
**removed**. A bug fix or new capability lands HERE once and every consumer gets it via
`thebashway update` (or, for a `bun link`ed dev setup like lifeofbash's, immediately — the consumer
points at this working tree).

This is the "permanent fix" the original extraction deferred. See the consume-package spec in the
lifeofbash repo (`docs/superpowers/specs/2026-06-08-thebashway-consume-package.md`).

## Becoming a consumer

A repo consumes the package by linking the engine and supplying one binding:

```
git clone https://github.com/lebashir/thebashway ~/thebashway
cd ~/thebashway && bun install && bun link
cd <your repo> && bun link thebashway      # then: thebashway init (or hand-author the config)
```

A `thebashway.config.ts` (see `examples/`) declares the repo's surfaces, rails, learning stores,
sinks, design bar, and loop-data `paths`. The CLI loads it from the cwd, or via `--config <path>`
(lifeofbash invokes `thebashway --config orchestrator/thebashway.config.ts`).
