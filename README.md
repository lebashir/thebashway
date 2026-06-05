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

## Install (3 steps)

1. **Get thebashway** (once, anywhere on your machine):

   ```
   git clone <thebashway-repo> ~/thebashway
   cd ~/thebashway && bun install
   ```

2. **Make the command easy to type** (optional but nice):

   ```
   cd ~/thebashway && bun link
   ```

   Now you can type `thebashway` anywhere. (Skip this and you can always run it the long
   way: `bun run ~/thebashway/src/cli.ts ...`.)

3. **Set it up in your project** — go to your project folder and run:

   ```
   thebashway init
   ```

   It looks at your project, figures out how you build and test, and writes a small
   settings file (`thebashway.config.ts`). It prints what it detected — **read that line
   and make sure the build/test commands look right.** If they don't, open
   `thebashway.config.ts` and fix the `chain` list. That's the only thing you might edit.

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

---

## What it does behind the scenes

1. It works on a **separate branch**, never directly on your main code.
2. It **checks its own work** by running your real build and tests.
3. It **only keeps changes that pass** — if the tests fail, the work stays on the branch.
4. It **asks you first** before anything it can't take back (see Safety below).
5. It **remembers mistakes** so it doesn't repeat them next time.

---

## Safety

thebashway will **never** send an email, message a person, delete data, or deploy to
production on its own. Anything like that is automatically set aside and flagged for you to
approve. It leans cautious on purpose: if a task even *looks* like it might reach a real
person or destroy something, it stops and asks. The worst case is it asks you about
something harmless — never that it does something it shouldn't.

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
