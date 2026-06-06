---
description: Set up thebashway in the current repo (detect build/test, scaffold the config + local store)
---

Run `thebashway init` in the current project to make it buildable by thebashway.

Steps:
1. Run the init command from the repo root:
   ```
   thebashway init
   ```
   (or, if the command isn't linked: `bun run <thebashway>/src/cli.ts init`)
2. Read the "Detected: ..." line it prints and confirm the build/test commands match how
   this repo really builds. If not, open `thebashway.config.ts` and fix the `chain` list.
3. Confirm prerequisites it reports (the `claude` command on PATH, a git repo).

Once set up, the user can run `thebashway fix <target>` or `thebashway build "<feature>"`.
Do not run `fix`/`build` automatically — those spawn headless Claude and change code; let
the user invoke them.
