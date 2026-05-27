# build queue

The shared work queue for thebashway. One item per `- [ ]` bullet. Fields are
indented `Key: value` lines. The `@` tag marks status: `@unclaimed`,
`@<session> / <branch>` (claimed), `@blocked (reason)`, or `@done` (also flip the
box to `- [x]`). `Territory` is a comma-separated glob list — the files the unit
may touch (scope-diff enforces it). `Clarifications` is optional, filled at intake.
Parsed by thebashway's `parseQueue`. Coordinate concurrent sessions through this
one file (the lock serializes claims).

<!-- Example (commented so the parser sees an empty live queue):
- [ ] Reskin the settings page        @unclaimed
  Goal: bring settings up to the design bar; presentational only.
  Territory: app/src/sections/settings/**, app/src/registry.ts
  Done-when: verify green + cold-review pass + deployed
  Clarifications:
    - Q: keep the existing tab order? A: yes.
-->
