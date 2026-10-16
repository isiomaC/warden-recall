import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp, graphProvider } from "./server.ts";

const port = Number(process.env.PORT ?? 8787);
const app = createApp(graphProvider());

// Serve the built UI when it exists (pnpm start). In development Vite serves it and proxies /api here.
if (existsSync("web/dist")) {
  app.use("/*", serveStatic({ root: "./web/dist" }));
  app.get("*", serveStatic({ path: "./web/dist/index.html" }));
}

serve({ fetch: app.fetch, port }, () => console.log(`Warden Recall listening on http://localhost:${port}`));
