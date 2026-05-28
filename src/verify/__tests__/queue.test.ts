import { test, expect } from "bun:test";
import { parseQueue, serializeItem, type QueueItem } from "../../queue";

const SAMPLE = `# build queue

- [ ] Reskin the Goals organ to Glass        @unclaimed
  Goal: bring the Goals view up to the Glass kit bar; presentational only.
  Territory: organs/src/sections/money/components/Goals*, organs/src/registry.ts
  Done-when: verify green + cold-review pass + deployed
  Clarifications:
    - Q: keep the existing sort order? A: yes.
    - Q: milestone hook in scope? A: no, defer.

- [ ] Add ingest dedup        @session-A / branch-ingest-fix
  Goal: dedupe staged_emails on message-id.
  Territory: tools/ingest/**
  Done-when: verify green

- [x] Tools: fix flaky test        @done
  Goal: stabilize the clock test.
  Territory: tools/test/**
  Done-when: verify green
`;

test("parses all items with status", () => {
  const items = parseQueue(SAMPLE);
  expect(items).toHaveLength(3);
  expect(items[0].status).toBe("unclaimed");
  expect(items[1].status).toBe("claimed");
  expect(items[1].claim).toEqual({ session: "session-A", branch: "branch-ingest-fix" });
  expect(items[2].status).toBe("done");
});

test("parses territory as a trimmed list", () => {
  const items = parseQueue(SAMPLE);
  expect(items[0].territory).toEqual([
    "organs/src/sections/money/components/Goals*",
    "organs/src/registry.ts",
  ]);
});

test("parses clarifications when present, empty when absent", () => {
  const items = parseQueue(SAMPLE);
  expect(items[0].clarifications).toEqual([
    { q: "keep the existing sort order?", a: "yes." },
    { q: "milestone hook in scope?", a: "no, defer." },
  ]);
  expect(items[1].clarifications).toEqual([]);
});

test("ignores items inside HTML comments (commented examples are not live)", () => {
  const md = `# build queue\n\n<!--\n- [ ] Example commented out        @unclaimed\n  Goal: should not parse.\n  Territory: tools/**\n-->\n`;
  expect(parseQueue(md)).toHaveLength(0);
});

test("parses @parked (reason) and @parked-on:<title>", () => {
  const md = `# queue\n\n- [ ] X        @parked (needs schema call)\n  Goal: a\n  Territory: t/**\n  Done-when: v\n\n- [ ] Y        @parked-on:X\n  Goal: a\n  Territory: t/**\n  Done-when: v\n  DependsOn: X\n`;
  const items = parseQueue(md);
  expect(items[0].status).toBe("parked");
  expect(items[0].parkReason).toBe("needs schema call");
  expect(items[1].status).toBe("parked-on");
  expect(items[1].parkedOn).toBe("X");
  expect(items[1].dependsOn).toEqual(["X"]);
});

test("serializeItem renders @parked + Park-reason line, and round-trips", () => {
  const item: QueueItem = {
    title: "Z",
    status: "parked",
    parkReason: "ask Bashir",
    goal: "g",
    territory: ["t/**"],
    doneWhen: "v",
    clarifications: [],
  };
  const re = parseQueue(serializeItem(item))[0];
  expect(re.status).toBe("parked");
  expect(re.parkReason).toBe("ask Bashir");
});

test("serializeItem renders DependsOn and round-trips", () => {
  const item: QueueItem = {
    title: "W",
    status: "unclaimed",
    goal: "g",
    territory: ["t/**"],
    doneWhen: "v",
    dependsOn: ["X", "Y"],
    clarifications: [],
  };
  const text = serializeItem(item);
  expect(text).toContain("DependsOn: X, Y");
  const re = parseQueue(text)[0];
  expect(re.dependsOn).toEqual(["X", "Y"]);
});

test("serializeItem round-trips through parseQueue", () => {
  const item: QueueItem = {
    title: "Do a thing",
    status: "unclaimed",
    goal: "a goal",
    territory: ["tools/**"],
    doneWhen: "verify green",
    clarifications: [],
  };
  const reparsed = parseQueue(serializeItem(item));
  expect(reparsed[0].title).toBe("Do a thing");
  expect(reparsed[0].territory).toEqual(["tools/**"]);
  expect(reparsed[0].status).toBe("unclaimed");
});
