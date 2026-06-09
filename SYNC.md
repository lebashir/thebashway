# How this package relates to lifeofbash

This package's engine (`src/engine/`) was **extracted from** `lifeofbash/tools/orchestrator`
and then **generalized** behind an injected `ProjectBinding` (`src/binding.ts`). As of
**2026-06-08, lifeofbash CONSUMES this package**: its `tools/orchestrator/` is now just a binding
(`thebashway.config.ts`) plus its data/learning stores — the engine, CLI, verify gate, granular
driver verbs, and build-method skill all come from here.

## Decoupled: a pinned dependency, not a folder link

As of **2026-06-09**, lifeofbash consumes thebashway the way it consumes any other dependency — it
does **not** reach into this sibling folder at runtime:

- **Engine** — a pinned GitHub dependency (`"thebashway": "github:lebashir/thebashway"` in
  package.json), fetched into `node_modules` as a real directory and pinned to an exact commit in
  `bun.lock`.
- **Method** — the Claude Code plugin (skill + slash commands), from the self-hosted marketplace.

(An earlier dev setup `bun link`ed this working tree directly; that coupling was removed — two
sessions sharing one checkout collide. The pin is the clean session model: evolve thebashway in its
own repo, publish, and let each consumer pull a version on its own schedule.)

## One copy, no drift — and no surprise updates

The old two-copy drift risk is gone (the `check-sync` command and `.sync-ref` tracker were removed):
a fix or feature lands HERE once, is pushed to GitHub, and a consumer then takes it **deliberately**:

```
# in the consuming repo
bun update thebashway            # engine: re-resolve main + repin bun.lock to the new commit
claude plugin update thebashway  # method: refresh the skill + slash commands
```

Because the engine is pinned, in-progress work here never silently changes a consumer — it upgrades
when it chooses. This is the "permanent fix" the original extraction deferred. (See the
consume-package spec in the lifeofbash repo,
`docs/superpowers/specs/2026-06-08-thebashway-consume-package.md`.)

## Becoming a consumer

A repo consumes the package by adding it as a dependency + installing the plugin, then supplying one
binding:

```
# in the consuming repo
bun add github:lebashir/thebashway             # engine (pins a commit in bun.lock)
claude plugin marketplace add lebashir/thebashway
claude plugin install thebashway@thebashway    # method (skill + slash commands)
bunx thebashway init                           # detect build/test, scaffold the config + store, enable the plugin
```

`thebashway init` writes a `thebashway.config.ts` (see `examples/`) that declares the repo's
surfaces, rails, learning stores, sinks, design bar, and loop-data `paths`. Invoke the CLI with
`bunx thebashway <verb>` (or a package script); it loads the config from the cwd, or via
`--config <path>` — lifeofbash runs `bun run thebashway --config orchestrator/thebashway.config.ts`.

(Actively co-developing the engine alongside a consumer? You can `bun link` this working tree for a
deliberate dev loop instead of the GitHub dep — but that re-introduces the shared-tree coupling, so
prefer the pinned dependency for normal use.)
