# Wiring thebashway into a project

Copy these four files into your project's `tools/orchestrator/` and adapt them.
The engine + method come from the `thebashway` package; only these are yours.

## Steps

1. **Add the package** (path dependency to your local checkout) in the project's
   `package.json`:
   ```json
   { "dependencies": { "thebashway": "file:../thebashway" } }
   ```
   then `pnpm install` / `bun install`. (Adjust the relative path.)

2. **Copy this template** into the project:
   ```
   mkdir -p tools/orchestrator
   cp <thebashway>/template/{config.ts,required-touches.ts,queue.md,verify.ts} tools/orchestrator/
   ```

3. **Edit `config.ts`** — define your surfaces and their tsc/lint/test/build/smoke
   commands. **Edit `required-touches.ts`** — add your completeness rules (start
   empty). `verify.ts` usually needs no edits (adjust `repoRoot` depth if you move it).

4. **Install the skill globally** (once): run `<thebashway>/install.sh`. Now any
   Claude Code session can invoke the `thebashway` skill.

5. **Run the gate:**
   ```
   bun run tools/orchestrator/verify.ts --surface app --base <ref> [--territory "app/src/x/**"]
   ```
   Add a `"verify"` script to your `package.json` if you like.

## Off-shape projects

thebashway assumes a JS/TS repo with a build step and HTTP routes. For a Python
CLI or a server-less library, adapt `config.ts`: smoke becomes a CLI invocation
asserting an exit code; drop the build/freshness checks if there is no build/
codegen. The skill's "applicability envelope" section spells this out.
