import { defineConfig } from "@playwright/test";

// End-to-end tests drive the real built UI against the real API, FalkorDB, Warden and MemStack.
// A separate graph, port and memory directory keep them away from a running demo.
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:8799",
    channel: "chrome",
    colorScheme: "light",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm build:web && GRAPH_NAME=e2e PORT=8799 MEMSTACK_DIR=.data/e2e-memstack DEMO_AS_OF=2026-10-18T10:00:00Z node src/api/main.ts",
    url: "http://localhost:8799/",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
