import { FalkorDB } from "falkordb";

export type Db = Awaited<ReturnType<typeof FalkorDB.connect>>;
export type Graph = ReturnType<Db["selectGraph"]>;

export const GRAPH_NAME = process.env.GRAPH_NAME ?? "northstar";

export class GraphUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`graph_unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/**
 * `onLost` runs when the connection drops. The client is an EventEmitter that emits "error" on a socket
 * failure, and an unhandled "error" event kills the process, so a listener is always attached.
 */
export async function connect(onLost?: (e: Error) => void): Promise<Db> {
  try {
    const db = await FalkorDB.connect({
      socket: {
        host: process.env.FALKORDB_HOST ?? "localhost",
        port: Number(process.env.FALKORDB_PORT ?? 6379),
        // fail fast instead of retrying forever; the option exists at runtime but is missing from the typings
        reconnectStrategy: false,
        connectTimeout: 3000,
      } as any,
    });
    db.on("error", (e: Error) => onLost?.(e));
    return db;
  } catch (e) {
    throw new GraphUnavailableError(e);
  }
}

const LABELS = ["Service", "Team", "Person", "Project", "ADR", "Document", "Incident", "Ticket"];

/** Idempotent: id indexes for every label plus the full-text index on Service.name. */
export async function ensureIndexes(g: Graph): Promise<void> {
  for (const l of LABELS) {
    try { await g.query(`CREATE INDEX FOR (n:${l}) ON (n.id)`); } catch { /* already exists */ }
  }
  try { await g.query(`CALL db.idx.fulltext.createNodeIndex('Service', 'name')`); } catch { /* already exists */ }
}

export async function resetGraph(db: Db, name = GRAPH_NAME): Promise<Graph> {
  const g = db.selectGraph(name);
  try { await g.delete(); } catch { /* graph did not exist */ }
  return g;
}
