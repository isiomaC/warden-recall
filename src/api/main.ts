import { serve } from "@hono/node-server";
import { createApp, graphProvider } from "./server.ts";

const port = Number(process.env.PORT ?? 8787);
const app = createApp(graphProvider());
serve({ fetch: app.fetch, port }, () => console.log(`Warden Recall API listening on http://localhost:${port}`));
