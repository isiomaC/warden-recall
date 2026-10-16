import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { ask, PRESETS } from "../agent/answer.ts";
import { effectiveAsOf, InvalidAsOfError } from "../clock.ts";
import { connect, ensureIndexes, GraphUnavailableError, GRAPH_NAME, resetGraph, type Db, type Graph } from "../graph/client.ts";
import type { EvidenceEdge, EvidenceNode, RawEdge, RawNode } from "../graph/paths.ts";
import { evidenceNode } from "../graph/paths.ts";
import { IngestError, ingestDocuments, loadDocuments } from "../ingestion/ingest.ts";
import { buildDraft, EscalationError, listTickets, submitEscalation } from "../actions/escalation.ts";
import { recallInvestigations, saveInvestigation } from "../actions/memory.ts";
import { createMemStackMemory, type InvestigationMemory } from "../integrations/memstack.ts";
import { createWardenPolicyAuthority, type PolicyAuthority } from "../integrations/warden.ts";

const FIXTURES = resolve("fixtures");
const SEED_DIR = "fixtures/northstar";
const UPDATE_DIR = "fixtures/updates";

const AskBody = z.strictObject({
  question: z.string().max(500).optional(),
  preset: z.enum(Object.keys(PRESETS) as [keyof typeof PRESETS, ...Array<keyof typeof PRESETS>]).optional(),
  serviceId: z.string().max(100).optional(),
  incidentId: z.string().max(100).optional(),
  intent: z.enum(["investigate", "impact", "owner", "decisions"]).optional(),
  asOf: z.string().max(40).optional(),
});

/** Lazily (re)connects, so the API recovers when FalkorDB comes back after an outage. */
export function graphProvider(name = GRAPH_NAME) {
  let db: Db | null = null;
  return {
    name,
    async graph(): Promise<Graph> {
      if (!db) db = await connect();
      return db.selectGraph(name);
    },
    async reset(): Promise<Graph> {
      if (!db) db = await connect();
      return resetGraph(db, name);
    },
    drop() { const d = db; db = null; void d?.close().catch(() => {}); },
    async close() { await db?.close().catch(() => {}); db = null; },
  };
}
export type GraphProvider = ReturnType<typeof graphProvider>;

export type Services = { policy: PolicyAuthority; memory: InvestigationMemory };
export const defaultServices = (): Services => ({ policy: createWardenPolicyAuthority(), memory: createMemStackMemory() });

const IncidentBody = z.strictObject({ incidentId: z.string().max(60).default("inc-102"), asOf: z.string().max(40).optional() });
const SubmitBody = IncidentBody.extend({
  draftId: z.string().max(40),
  actor: z.string().max(40),
  confirm: z.boolean(),
});
const MemoryBody = z.strictObject({ incidentId: z.string().max(60).default("inc-102"), sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), asOf: z.string().max(40).optional() });
const ESCALATION_STATUS = { incident_not_found: 404, no_owner: 409, stale_draft: 409, confirmation_required: 400 } as const;

export function createApp(provider: GraphProvider, services: Services = defaultServices()) {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof GraphUnavailableError) {
      provider.drop();
      return c.json({ error: "graph_unavailable", message: "FalkorDB is unreachable. No answer or action is possible without the graph." }, 503);
    }
    if (err instanceof EscalationError) return c.json({ error: err.code, message: err.message }, ESCALATION_STATUS[err.code]);
    if (err instanceof InvalidAsOfError) return c.json({ error: "bad_request", message: err.message }, 400);
    if (err instanceof IngestError) return c.json({ error: "ingest_rejected", message: err.message }, 422);
    if (err instanceof z.ZodError) return c.json({ error: "bad_request", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    console.error(err);
    return c.json({ error: "internal_error", message: "Unexpected server error." }, 500);
  });

  app.get("/api/health", async (c) => {
    const g = await provider.graph();
    const r = await g.query<{ n: number }>(`MATCH (n) RETURN count(n) AS n`);
    return c.json({ status: "ok", graph: provider.name, nodes: r.data?.[0]?.n ?? 0, asOf: new Date(effectiveAsOf()).toISOString(), demoClock: Boolean(process.env.DEMO_AS_OF) });
  });

  app.get("/api/presets", (c) => c.json(PRESETS));

  app.post("/api/ask", async (c) => {
    const body = AskBody.parse(await c.req.json().catch(() => ({})));
    const asOf = effectiveAsOf(body.asOf);
    return c.json(await ask(await provider.graph(), { ...body, asOf }));
  });

  // Escalation: propose is read-only; submit needs explicit confirmation and Warden's allow before anything is written.
  app.post("/api/escalation/propose", async (c) => {
    const body = IncidentBody.parse(await c.req.json().catch(() => ({})));
    const g = await provider.graph();
    return c.json({ draft: await buildDraft(g, body.incidentId, effectiveAsOf(body.asOf)), tickets: await listTickets(g, body.incidentId) });
  });

  app.post("/api/escalation/submit", async (c) => {
    const body = SubmitBody.parse(await c.req.json().catch(() => ({})));
    const g = await provider.graph();
    const result = await submitEscalation(g, services.policy, {
      incidentId: body.incidentId, draftId: body.draftId, actorId: body.actor, confirm: body.confirm, asOf: effectiveAsOf(body.asOf),
    });
    return c.json({ ...result, tickets: await listTickets(g, body.incidentId) }, result.decision.effect === "allow" ? 200 : 403);
  });

  app.get("/api/tickets", async (c) => c.json({ tickets: await listTickets(await provider.graph(), c.req.query("incidentId") ?? "inc-102") }));

  app.get("/api/audit", (c) => c.json(services.policy.audit()));

  // Memory (MemStack). Saved from a fresh graph answer; recalled memories are revalidated against the graph.
  app.post("/api/memory/save", async (c) => {
    const body = MemoryBody.parse(await c.req.json().catch(() => ({})));
    const g = await provider.graph();
    try {
      const saved = await saveInvestigation(g, services.memory, { incidentId: body.incidentId, sessionId: body.sessionId, asOf: effectiveAsOf(body.asOf) });
      return saved ? c.json({ saved }) : c.json({ error: "incident_not_found", message: "Nothing to remember: the incident is unknown." }, 404);
    } catch (e) {
      if (e instanceof GraphUnavailableError) throw e;
      console.error(e);
      return c.json({ error: "memory_unavailable", message: "MemStack could not store the memory. Graph answers are unaffected." }, 503);
    }
  });

  app.get("/api/memory", async (c) => {
    const g = await provider.graph();
    try {
      return c.json({ memories: await recallInvestigations(g, services.memory, { incidentId: c.req.query("incidentId") ?? "inc-102", asOf: effectiveAsOf(c.req.query("asOf")) }) });
    } catch (e) {
      if (e instanceof GraphUnavailableError) throw e;
      console.error(e);
      return c.json({ error: "memory_unavailable", message: "MemStack is unavailable; showing graph facts only.", memories: [] }, 503);
    }
  });

  // The company graph for the visual: everything except Document nodes, with ownership as of the clock.
  app.get("/api/graph", async (c) => {
    const asOf = effectiveAsOf(c.req.query("asOf"));
    const g = await provider.graph();
    const [nodesR, edgesR] = await Promise.all([
      g.query<{ n: RawNode }>(`MATCH (n) WHERE NOT n:Document RETURN n`),
      g.query<{ a: RawNode; r: RawEdge; b: RawNode }>(`MATCH (a)-[r]->(b) WHERE NOT a:Document AND NOT b:Document RETURN a, r, b`),
    ]);
    const nodes: EvidenceNode[] = (nodesR.data ?? []).map((x) => evidenceNode(x.n));
    const edges: EvidenceEdge[] = [];
    for (const { a, r, b } of edgesR.data ?? []) {
      if (r.relationshipType === "OWNS") {
        const p = r.properties;
        if (!(p.validFrom <= asOf && (p.validTo == null || asOf < p.validTo))) continue;
      }
      edges.push({ from: a.properties.id, to: b.properties.id, type: r.relationshipType });
    }
    return c.json({ asOf: new Date(asOf).toISOString(), nodes, edges });
  });

  app.get("/api/source/:id", async (c) => {
    const g = await provider.graph();
    const r = await g.query<{ id: string; title: string; path: string }>(
      `MATCH (d:Document {id:$id}) RETURN d.id AS id, d.title AS title, d.path AS path`, { params: { id: c.req.param("id") } });
    const row = r.data?.[0];
    if (!row) return c.json({ error: "not_found", message: "No such source document." }, 404);
    const full = resolve(row.path);
    if (!full.startsWith(FIXTURES + sep)) return c.json({ error: "forbidden", message: "Source is outside the fixture directory." }, 403);
    return c.json({ ...row, content: await readFile(full, "utf8") });
  });

  // The pending ownership document, shown before it is ingested.
  app.get("/api/update-preview", async (c) => {
    const docs = await loadDocuments(UPDATE_DIR);
    const g = await provider.graph();
    const ids = docs.map((d) => d.data.id);
    const have = (await g.query<{ id: string }>(`MATCH (d:Document) WHERE d.id IN $ids RETURN d.id AS id`, { params: { ids } })).data?.map((x) => x.id) ?? [];
    return c.json({
      updates: await Promise.all(docs.map(async (d) => ({ id: d.data.id, path: d.path, title: d.title, applied: have.includes(d.data.id), content: await readFile(d.path, "utf8") }))),
    });
  });

  // Same ingestion pipeline as the initial seed, applied live with no restart.
  app.post("/api/ingest-update", async (c) => {
    const result = await ingestDocuments(await provider.graph(), await loadDocuments(UPDATE_DIR));
    return c.json({ result, ingestedAt: new Date().toISOString() });
  });

  // Demo reset: wipe the graph and re-seed from the Markdown fixtures.
  app.post("/api/reset", async (c) => {
    const g = await provider.reset();
    await ensureIndexes(g);
    const result = await ingestDocuments(g, await loadDocuments(SEED_DIR));
    return c.json({ result });
  });

  return app;
}
