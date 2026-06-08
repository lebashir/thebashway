# thebashway

A helper that lets Claude build and fix code in your project on its own — safely.
You give it a one-line request; it does the work on a side branch, checks its own
work, and only keeps changes that pass.

It has two modes:

- **Fix** — point it at a file, folder, or your whole project and say what's wrong (or
  just let it look for problems). It finds real issues and fixes them.
- **Build** — describe a small feature in one line. It plans it, builds it, and checks it.

You can pick the mode yourself (`fix` / `build`) or just type what you want and let it
choose.

---

## What you need first

Three things. Each has a quick check you can paste into your terminal.

1. **Bun** (it runs the tool). Check: `bun --version` — if you see a number, you're good.
   No bun? Install from https://bun.sh.
2. **The `claude` command** (this is what actually writes the code). Check: `claude --version`.
   No claude? Install Claude Code first.
3. **Your project is in git.** Check: run `git status` inside your project — if it doesn't
   error, you're good. Not in git? Run `git init` once.

That's it. You don't need any database, account, or API key.

---

## Install

thebashway comes in **two pieces**, and you want both:

- the **engine** — the Bun program that does the work (you run it as `thebashway …`);
- the **method** — the skill + slash commands that teach Claude *how* to drive it.

(They're separate on purpose: a Claude Code plugin can't run an install step, so the Bun
engine can't ride inside the plugin. Setting up the engine is quick.)

**1. Get the engine** (once, anywhere on your machine):

```
git clone https://github.com/lebashir/thebashway ~/thebashway
cd ~/thebashway && bun install && bun link
```

`bun link` lets you type `thebashway` from anywhere. (Skip it and run the long way:
`bun run ~/thebashway/src/cli.ts …`.)

**2. Get the method into Claude.** Pick one:

- **Plugin marketplace** (recommended — discoverable, and it updates with `claude plugin update`):

  ```
  claude plugin marketplace add lebashir/thebashway
  claude plugin install thebashway@thebashway
  ```

- **Or straight from the clone** (simplest if you already cloned the engine):

  ```
  ~/thebashway/install.sh
  ```

**3. Set it up in your project** — go to your project folder and run:

```
thebashway init
```

It looks at your project, figures out how you build and test, and writes a small settings file
(`thebashway.config.ts`). It prints what it detected — **read that line and make sure the
build/test commands look right.** If they don't, open `thebashway.config.ts` and fix the
`chain` list. That's the only thing you might edit.

---

## Turn it on only where you use it

Installing the plugin makes it **available** everywhere, but it does **not** force itself into
every repo. Two separate things make thebashway active in a project, and you control both per
project:

1. **`thebashway init`** — sets up the *engine* for that repo (writes `thebashway.config.ts`). Only
   the repos you init can be built/fixed.
2. **Enabling the plugin in that repo** — turns on the *method* (the skill + slash commands) for
   that repo's Claude sessions.

So you can install once and keep it **off by default**, switching it on only where you've init'd:

```
# once, globally available but not auto-on:
claude plugin install thebashway@thebashway
claude plugin disable thebashway          # off everywhere by default

# in each repo where you use thebashway — one step:
thebashway init
```

`thebashway init` sets up the engine **and** enables the plugin for that repo: it merges
`"enabledPlugins": { "thebashway@thebashway": true }` into the repo's `.claude/settings.json`
(preserving anything already there). That file is committable, so teammates who clone the repo get
prompted to enable it too. Repos you never `init` never load the skill — no extra tokens, no noise.

(Installed the method via `install.sh` instead of the plugin? Run `thebashway init
--no-enable-plugin` to skip that step.)

---

## Use it

Two things you can type. Run them from inside your project.

**Fix something:**

```
thebashway fix src/components/Cart.tsx
```

It looks at that file, finds real problems, fixes them on a branch named `tbw/...`, runs
your tests, and — if everything passes — keeps the changes. You'll see a short summary of
what it found and did. (Want it to stop before merging so you can look first? Add
`--no-land`.)

**Build something:**

```
thebashway build "add a button that exports the table to CSV"
```

It plans the feature, builds it on a branch, runs your tests, and shows you the result.
(Want to just see the plan without building? Add `--dry-run`.)

**Or just say what you want** and let it choose the mode:

```
thebashway "the date on the receipt is off by one day"
```

**Give your project a north star** — the first thing you do in a new repo:

```
thebashway brief
```

This drafts a short, plain-language statement of what your project *is* — its purpose, who
it's for, what's in and out of scope, and how you'd know it's working — inferred from your
repo, then confirmed in a quick back-and-forth with the agent (it asks plain questions, maps
your answers to the structure, and writes it for you — you never edit a config). You can pause
and pick up anytime: it saves progress and, on resume, asks only what's left.

**It comes first by design.** `build` / `fix` / `run-to-goal` won't run until your north star is
confirmed — they pause and walk you through setting it up — so the engine always knows what it's
building toward. (Just want a quick one-off, or running unattended? Pass `--skip-brief`, or set
`requireBrief: false` in your config.) Once it's there, every `fix` / `build` / `audit` reads it
as guiding context, so the work bends toward what the project is actually for, and it *warns* —
never blocks — when a design drifts outside the scope you declared. You only ever write the brief
yourself; thebashway proposes changes for your review and never rewrites your vision to fit a request.

With a north star in place, you can point thebashway at a goal and let it run:

```
thebashway run-to-goal                  # drive every required success-criterion to green
thebashway run-to-goal --target ship    # or aim at just one slice of the goal-set
```

It loops — build, check the criteria, repeat — until the goal is met, then stops on its own.
It's bounded by hard caps (iterations, wall-clock, and a build-spend ceiling), and it stays
honest: it declares "done" only when the criteria *you* defined actually pass, distinguishes
"the whole goal is met" from "a slice is met," and parks for you whenever a human judgment
(a milestone) is pending.

---

## Keeping it up to date

Two pieces, two one-liners (run them now and then):

**Engine:**

```
thebashway update
```

You installed the engine **once** in one place (the `~/thebashway` clone). Every project just
points back at that clone — `thebashway init` only writes a small settings file into your
project, never a copy of the tool. So `thebashway update` (a fast-forward pull + reinstall of
anything that changed) reaches **every** project you use it in at once, and leaves your
per-project settings (`thebashway.config.ts`) and history (`.thebashway/`) exactly as they are.
(The long way, if you skipped `bun link`: `cd ~/thebashway && git pull && bun install`.) If it
says you have **local uncommitted changes**, you edited something inside the clone — commit or
stash first; if it says it **isn't a git checkout**, re-install from source.

**Method** (the Claude skill + commands):

```
claude plugin update thebashway
```

If you installed the method from the clone with `install.sh` instead of the marketplace, it's a
symlink — so `thebashway update` already refreshed it and there's nothing else to do.

---

## What it does behind the scenes

1. It works on a **separate branch**, never directly on your main code.
2. It **checks its own work** by running your real build and tests.
3. It **only keeps changes that pass** — if the tests fail, the work stays on the branch.
4. It **asks you first** before anything it can't take back (see Safety below).
5. It **remembers mistakes** so it doesn't repeat them next time.

---

## Safety

thebashway **ships by default**: once a change passes your real build and tests on its branch,
it merges to your main branch and deploys — that's the point of the loop. To stop short of
deploying, pass `--no-land` and it builds + integrates, then leaves the change staged on a
branch for you. (A brand-new web page is also staged rather than deployed, since an automated
smoke test can't exercise a route it has never seen.)

What it will **never** do on its own: send an email, message a person, or delete/destroy data.
Anything like that is automatically set aside and flagged for you to approve — and it leans
cautious on purpose: if a task even *looks* like it might reach a real person or destroy
something, it stops and asks. (Deploys don't fall in this bucket — a deploy is reversible, you
can roll it back, whereas a sent email or a deleted row is not.) The worst case is it asks you
about something harmless — never that it does something it shouldn't.

---

## When something goes wrong

- **"no binding found ..."** — you haven't set up this project yet. Run `thebashway init`.
- **"the `claude` command is not on your PATH"** — install Claude Code, then try again.
- **The build/test step failed and nothing got kept** — that's working as intended; the
  change is still on its `tbw/...` branch. Check `thebashway.config.ts` to make sure the
  build/test commands match how your project really builds.
- **Nothing happened / it found nothing** — try pointing `fix` at a specific file or folder
  instead of the whole project.

---

For the full command reference and settings, see [USAGE.md](./USAGE.md).
For how this relates to the lifeofbash project it came from, see [SYNC.md](./SYNC.md).
