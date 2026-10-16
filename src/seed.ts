import { connect, ensureIndexes, GRAPH_NAME, resetGraph } from "./graph/client.ts";
import { ingestDocuments, loadDocuments } from "./ingestion/ingest.ts";

const db = await connect();
try {
  const g = await resetGraph(db);
  await ensureIndexes(g);
  const result = await ingestDocuments(g, await loadDocuments("fixtures/northstar"));
  console.log(`Seeded graph "${GRAPH_NAME}":`, result);
} finally {
  await db.close();
}
