// tools/orchestrator/verify/__tests__/config.test.ts
import { test, expect } from "bun:test";
import { SURFACES } from "../../config";

test("both surfaces are configured", () => {
  expect(Object.keys(SURFACES).sort()).toEqual(["organs", "tools"]);
});

test("organs build fires prebuild (real pnpm build, not next build)", () => {
  const build = SURFACES.organs.chain.find((c) => c.name === "build");
  expect(build?.cmd).toEqual(["pnpm", "build"]);
});

test("tools carries the Tabby bun-TLS workaround", () => {
  expect(SURFACES.tools.env?.NODE_TLS_REJECT_UNAUTHORIZED).toBe("0");
});
