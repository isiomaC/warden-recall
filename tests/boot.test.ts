import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

// Vitest transpiles TypeScript itself, so it cannot catch syntax Node's native type stripping rejects
// (parameter properties, enums). The seed script and API server run on plain `node`, so load them that way.
it("the API server module loads under plain node", async () => {
  const entry = "src/api/server.ts";
  const { stderr } = await promisify(execFile)("node", ["--input-type=module", "-e", `await import("./${entry}"); process.exit(0)`], { cwd: process.cwd() });
  expect(stderr).toBe("");
});

it("the query, action and integration modules load under plain node", async () => {
  const { stderr } = await promisify(execFile)("node", ["--input-type=module", "-e", `await import("./src/graph/queries.ts"); await import("./src/actions/escalation.ts"); await import("./src/integrations/warden.ts"); await import("./src/integrations/memstack.ts"); process.exit(0)`]);
  expect(stderr).toBe("");
});
