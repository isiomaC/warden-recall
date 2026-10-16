import type { Graph } from "./client.ts";
import { GraphUnavailableError } from "./client.ts";
import { toEvidence, type Evidence, type RawEdge, type RawNode } from "./paths.ts";

/** Every query result carries the exact Cypher and sanitized parameters for the evidence inspector. */
export type QueryRecord = { name: string; cypher: string; params: Record<string, unknown> };
export type Queried<T> = { query: QueryRecord; rows: T[] };

async function q<T>(g: Graph, name: string, cypher: string, params: Record<string, unknown> = {}): Promise<Queried<T>> {
  try {
    const r = await g.query<T>(cypher, { params: params as any });
    return { query: { name, cypher: cypher.replace(/\s+/g, " ").trim(), params }, rows: r.data ?? [] };
  } catch (e) {
    // A refused connection or dropped socket means the graph is down: fail closed, never fall back to canned data.
    if (e instanceof Error && /ECONNREFUSED|closed|Socket|not open|timeout/i.test(e.message)) throw new GraphUnavailableError(e);
    throw e;
  }
}

// Q6: full-text service resolution. Tokens are stripped of query syntax and prefix-matched.
export type ServiceCandidate = { id: string; name: string; tier: number };
export async function findService(g: Graph, text: string) {
  const tokens = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 6);
  if (!tokens.length) return { query: null, candidates: [] as ServiceCandidate[], ambiguous: false };
  const term = tokens.map((t) => `${t}*`).join(" ");
  const r = await q<ServiceCandidate>(g, "Q6 resolve service (full-text)",
    `CALL db.idx.fulltext.queryNodes('Service', $term) YIELD node
     RETURN node.id AS id, node.name AS name, node.tier AS tier ORDER BY node.id LIMIT 5`, { term });
  return { query: r.query, candidates: r.rows, ambiguous: r.rows.length > 1 };
}

// Q1: dependents of the failed service, traversing incoming DEPENDS_ON edges.
export type ImpactedService = { id: string; name: string; hops: number; evidence: Evidence };
export async function traceImpact(g: Graph, serviceId: string, maxDepth = 4) {
  const depth = Math.min(Math.max(Math.trunc(maxDepth), 1), 4);
  const r = await q<{ id: string; name: string; hops: number; nodes: RawNode[]; edges: RawEdge[] }>(g, "Q1 impact paths",
    `MATCH p=(dep:Service)-[:DEPENDS_ON*1..${depth}]->(failed:Service {id:$serviceId})
     RETURN dep.id AS id, dep.name AS name, length(p) AS hops, nodes(p) AS nodes, relationships(p) AS edges
     ORDER BY hops, id LIMIT 25`, { serviceId });
  // keep the shortest path per dependent
  const best = new Map<string, ImpactedService>();
  for (const row of r.rows) {
    if (!best.has(row.id)) best.set(row.id, { id: row.id, name: row.name, hops: row.hops, evidence: toEvidence(row.nodes, row.edges) });
  }
  return { query: r.query, impacted: [...best.values()] };
}

// Q2: owner as of a point in time, with its source document. Services without a record come back as unknown.
export type OwnerRecord = { serviceId: string; teamId: string | null; teamName: string | null; validFrom: number | null; validTo: number | null; sourceId: string | null; sourcePath: string | null };
export async function getOwners(g: Graph, serviceIds: string[], asOf: number) {
  const r = await q<Omit<OwnerRecord, "validTo"> & { validTo: number | null }>(g, "Q2 owner as of time",
    `MATCH (t:Team)-[o:OWNS]->(s:Service)
     WHERE s.id IN $serviceIds AND o.validFrom <= $asOf AND (o.validTo IS NULL OR $asOf < o.validTo)
     MATCH (d:Document) WHERE d.id = o.sourceId
     RETURN s.id AS serviceId, t.id AS teamId, t.name AS teamName, o.validFrom AS validFrom, o.validTo AS validTo, d.id AS sourceId, d.path AS sourcePath`,
    { serviceIds, asOf });
  const found = new Map(r.rows.map((x) => [x.serviceId, x]));
  const owners: OwnerRecord[] = serviceIds.map((id) =>
    found.get(id) ?? { serviceId: id, teamId: null, teamName: null, validFrom: null, validTo: null, sourceId: null, sourcePath: null });
  return { query: r.query, owners };
}

// Q-O: on-call is separate from ownership; callers compare the two.
export type OnCall = { personId: string; personName: string; teamId: string | null; serviceId: string };
export async function getOnCall(g: Graph, serviceIds: string[]) {
  const r = await q<OnCall>(g, "Q-O on-call",
    `MATCH (p:Person)-[:ON_CALL_FOR]->(s:Service) WHERE s.id IN $serviceIds
     OPTIONAL MATCH (p)-[:MEMBER_OF]->(t:Team)
     RETURN p.id AS personId, p.name AS personName, t.id AS teamId, s.id AS serviceId`, { serviceIds });
  return { query: r.query, onCall: r.rows };
}

// Q3: ADRs for a service with their sources and amendment relations. Amending never invalidates the amended ADR.
export type Decision = { id: string; title: string; date: number; sourceId: string; sourcePath: string; amends: string[]; amendedBy: string[] };
export async function getDecisions(g: Graph, serviceId: string) {
  const r = await q<Decision>(g, "Q3 decision provenance",
    `MATCH (s:Service {id:$serviceId})-[:HAS_DECISION]->(a:ADR)-[:DOCUMENTED_IN]->(d:Document)
     OPTIONAL MATCH (a)-[:AMENDS]->(older:ADR)
     OPTIONAL MATCH (newer:ADR)-[:AMENDS]->(a)
     RETURN a.id AS id, a.title AS title, a.date AS date, d.id AS sourceId, d.path AS sourcePath,
            collect(DISTINCT older.id) AS amends, collect(DISTINCT newer.id) AS amendedBy
     ORDER BY date`, { serviceId });
  return { query: r.query, decisions: r.rows };
}

// Q4: projects using the failed service or any of its dependents, with the dependency path to the failure.
export type ProjectImpact = { projectId: string; projectName: string; serviceId: string; hops: number; evidence: Evidence };
export async function getProjectImpact(g: Graph, serviceId: string) {
  const r = await q<{ projectId: string; projectName: string; serviceId: string; hops: number; nodes: RawNode[]; edges: RawEdge[] }>(g, "Q4 project impact",
    `MATCH (pr:Project)-[u:USES]->(s:Service)
     MATCH p=(s)-[:DEPENDS_ON*0..4]->(f:Service {id:$serviceId})
     RETURN pr.id AS projectId, pr.name AS projectName, s.id AS serviceId, length(p) AS hops, nodes(p) AS nodes, relationships(p) AS edges
     ORDER BY hops, projectId`, { serviceId });
  const best = new Map<string, ProjectImpact>();
  for (const row of r.rows) {
    if (best.has(row.projectId)) continue;
    const ev = toEvidence(row.nodes, row.edges);
    ev.nodes.push({ id: row.projectId, type: "Project", label: row.projectName });
    ev.edges.push({ from: row.projectId, to: row.serviceId, type: "USES" });
    best.set(row.projectId, { projectId: row.projectId, projectName: row.projectName, serviceId: row.serviceId, hops: row.hops, evidence: ev });
  }
  return { query: r.query, projects: [...best.values()] };
}

// Q5: earlier incidents on the same service.
export type RelatedIncident = { id: string; title: string; severity: string; status: string; openedAt: number };
export async function findRelatedIncidents(g: Graph, serviceId: string, excludeIncidentId = "") {
  const r = await q<RelatedIncident>(g, "Q5 related incidents",
    `MATCH (i:Incident)-[:AFFECTS]->(:Service {id:$serviceId}) WHERE i.id <> $exclude
     RETURN i.id AS id, i.title AS title, i.severity AS severity, i.status AS status, i.openedAt AS openedAt
     ORDER BY openedAt DESC LIMIT 10`, { serviceId, exclude: excludeIncidentId });
  return { query: r.query, incidents: r.rows };
}

// Incident lookup used by the preset investigation and the escalation policy.
export type IncidentRecord = { id: string; title: string; severity: string; status: string; openedAt: number; services: Array<{ id: string; name: string; tier: number }> };
export async function getIncident(g: Graph, incidentId: string) {
  const r = await q<{ id: string; title: string; severity: string; status: string; openedAt: number; sid: string; sname: string; tier: number }>(g, "Incident lookup",
    `MATCH (i:Incident {id:$incidentId})-[:AFFECTS]->(s:Service)
     RETURN i.id AS id, i.title AS title, i.severity AS severity, i.status AS status, i.openedAt AS openedAt,
            s.id AS sid, s.name AS sname, s.tier AS tier`, { incidentId });
  if (!r.rows.length) return { query: r.query, incident: null as IncidentRecord | null };
  const { id, title, severity, status, openedAt } = r.rows[0];
  return { query: r.query, incident: { id, title, severity, status, openedAt, services: r.rows.map((x) => ({ id: x.sid, name: x.sname, tier: x.tier })) } };
}
