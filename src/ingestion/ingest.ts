import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Graph } from "../graph/client.ts";
import { IngestError, parseDocumentText, type ParsedDoc } from "./parse-frontmatter.ts";
import type { Doc, DocKind } from "./schemas.ts";

export { IngestError };

export type IngestResult = {
  documentsIngested: number;
  documentsSkipped: number;
  nodesCreated: number;
  relationshipsCreated: number;
  ownershipClosed: number;
};

// Labels cannot be Cypher parameters; this fixed map is the only place they are interpolated.
const ENTITY_LABEL: Partial<Record<DocKind, string>> = {
  service: "Service", team: "Team", person: "Person", adr: "ADR", incident: "Incident", project: "Project",
};

export async function loadDocuments(...dirs: string[]): Promise<ParsedDoc[]> {
  const docs: ParsedDoc[] = [];
  const walk = async (dir: string) => {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".md")) docs.push(parseDocumentText(p, await readFile(p, "utf8")));
    }
  };
  for (const d of dirs) await walk(d);
  return docs;
}

type Run = (cypher: string, params?: Record<string, unknown>) => Promise<{ data?: any[]; metadata: string[] }>;

function tally(metadata: string[], key: string): number {
  const line = metadata.find((l) => l.startsWith(`${key}:`));
  return line ? Number(line.split(":")[1]) : 0;
}

const ms = (iso: string) => Date.parse(iso);

function findCycle(edges: Array<[string, string]>): string[] | null {
  const adj = new Map<string, string[]>();
  for (const [a, b] of edges) adj.set(a, [...(adj.get(a) ?? []), b]);
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    state.set(n, 1);
    stack.push(n);
    for (const m of adj.get(n) ?? []) {
      if (state.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m];
      if (!state.has(m)) { const c = visit(m); if (c) return c; }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of adj.keys()) if (!state.has(n)) { const c = visit(n); if (c) return c; }
  return null;
}

export async function ingestDocuments(g: Graph, docs: ParsedDoc[]): Promise<IngestResult> {
  const run: Run = (c, p) => g.query(c, p ? { params: p as any } : undefined) as any;
  const result: IngestResult = { documentsIngested: 0, documentsSkipped: 0, nodesCreated: 0, relationshipsCreated: 0, ownershipClosed: 0 };
  const count = (r: { metadata: string[] }) => {
    result.nodesCreated += tally(r.metadata, "Nodes created");
    result.relationshipsCreated += tally(r.metadata, "Relationships created");
  };

  // 1. Idempotency: same id + same hash is a no-op, same id + new content is rejected.
  const seen = new Set<string>();
  for (const d of docs) {
    if (seen.has(d.data.id)) throw new IngestError(`duplicate document id in batch: ${d.data.id}`);
    seen.add(d.data.id);
  }
  const existingDocs = new Map<string, string>(
    ((await run(`MATCH (d:Document) RETURN d.id AS id, d.hash AS hash`)).data ?? []).map((r) => [r.id, r.hash]),
  );
  const fresh: ParsedDoc[] = [];
  for (const d of docs) {
    const prior = existingDocs.get(d.data.id);
    if (prior === undefined) fresh.push(d);
    else if (prior === d.hash) result.documentsSkipped++;
    else throw new IngestError(`${d.path}: document ${d.data.id} already ingested with different content (documents are immutable)`);
  }

  // 2. Validate references against the batch plus what is already in the graph.
  const known = new Map<string, Set<string>>();
  const mark = (label: string, id: string) => known.set(label, (known.get(label) ?? new Set()).add(id));
  for (const r of (await run(`MATCH (n) WHERE n.id IS NOT NULL RETURN labels(n)[0] AS l, n.id AS id`)).data ?? []) mark(r.l, r.id);
  for (const d of fresh) { const l = ENTITY_LABEL[d.data.kind]; if (l) mark(l, d.data.id); else mark("Document", d.data.id); }
  const need = (d: ParsedDoc, label: string, id: string, field: string) => {
    if (!known.get(label)?.has(id)) throw new IngestError(`${d.path}: ${field} references unknown ${label} "${id}"`);
  };
  const dependsEdges: Array<[string, string]> = ((await run(`MATCH (a:Service)-[:DEPENDS_ON]->(b:Service) RETURN a.id AS a, b.id AS b`)).data ?? []).map((r) => [r.a, r.b]);
  const amendEdges: Array<[string, string]> = ((await run(`MATCH (a:ADR)-[:AMENDS]->(b:ADR) RETURN a.id AS a, b.id AS b`)).data ?? []).map((r) => [r.a, r.b]);
  for (const d of fresh) {
    const x = d.data;
    switch (x.kind) {
      case "service": x.dependsOn.forEach((s) => { need(d, "Service", s, "dependsOn"); dependsEdges.push([x.id, s]); }); break;
      case "person": need(d, "Team", x.team, "team"); x.onCallFor.forEach((s) => need(d, "Service", s, "onCallFor")); break;
      case "ownership":
        need(d, "Service", x.service, "service"); need(d, "Team", x.team, "team");
        if (x.supersedes) need(d, "Document", x.supersedes, "supersedes");
        break;
      case "adr": need(d, "Service", x.service, "service"); if (x.amends) { need(d, "ADR", x.amends, "amends"); amendEdges.push([x.id, x.amends]); } break;
      case "incident": x.services.forEach((s) => need(d, "Service", s, "services")); break;
      case "project": x.uses.forEach((s) => need(d, "Service", s, "uses")); break;
    }
  }
  const dc = findCycle(dependsEdges);
  if (dc) throw new IngestError(`dependency cycle: ${dc.join(" -> ")}`);
  const ac = findCycle(amendEdges);
  if (ac) throw new IngestError(`amends cycle: ${ac.join(" -> ")}`);

  // 3. Pass 1: entities (and their Document) for every non-ownership document.
  const docProps = (d: ParsedDoc) => ({ id: d.data.id, path: d.path, hash: d.hash, title: d.title, ingestedAt: Date.now() });
  for (const d of fresh) {
    const label = ENTITY_LABEL[d.data.kind];
    if (!label) continue;
    const x = d.data as Record<string, any>;
    count(await run(`MERGE (doc:Document {id:$id}) SET doc.path=$path, doc.hash=$hash, doc.title=$title, doc.ingestedAt=$ingestedAt`, docProps(d)));
    const props: Record<string, unknown> =
      x.kind === "service" ? { name: x.name, tier: x.tier }
      : x.kind === "team" ? { name: x.name }
      : x.kind === "person" ? { name: x.name, role: x.role }
      : x.kind === "project" ? { name: x.name }
      : x.kind === "adr" ? { title: d.title, date: ms(x.date) }
      : { title: d.title, severity: x.severity, status: x.status, openedAt: ms(x.openedAt) };
    count(await run(`MERGE (n:${label} {id:$id}) SET n += $props`, { id: x.id, props }));
    count(await run(`MATCH (n:${label} {id:$id}), (doc:Document {id:$id}) MERGE (n)-[:DOCUMENTED_IN]->(doc)`, { id: x.id }));
  }

  // 4. Pass 2: relationships.
  const edge = async (cypher: string, params: Record<string, unknown>) => count(await run(cypher, params));
  for (const d of fresh) {
    const x = d.data;
    switch (x.kind) {
      case "service":
        for (const s of x.dependsOn) await edge(`MATCH (a:Service {id:$a}), (b:Service {id:$b}) MERGE (a)-[:DEPENDS_ON]->(b)`, { a: x.id, b: s });
        break;
      case "person":
        await edge(`MATCH (p:Person {id:$p}), (t:Team {id:$t}) MERGE (p)-[:MEMBER_OF]->(t)`, { p: x.id, t: x.team });
        for (const s of x.onCallFor) await edge(`MATCH (p:Person {id:$p}), (s:Service {id:$s}) MERGE (p)-[:ON_CALL_FOR]->(s)`, { p: x.id, s });
        break;
      case "adr":
        await edge(`MATCH (s:Service {id:$s}), (a:ADR {id:$a}) MERGE (s)-[:HAS_DECISION]->(a)`, { s: x.service, a: x.id });
        if (x.amends) await edge(`MATCH (a:ADR {id:$a}), (b:ADR {id:$b}) MERGE (a)-[:AMENDS]->(b)`, { a: x.id, b: x.amends });
        break;
      case "incident":
        for (const s of x.services) await edge(`MATCH (i:Incident {id:$i}), (s:Service {id:$s}) MERGE (i)-[:AFFECTS]->(s)`, { i: x.id, s });
        break;
      case "project":
        for (const s of x.uses) await edge(`MATCH (p:Project {id:$p}), (s:Service {id:$s}) MERGE (p)-[:USES]->(s)`, { p: x.id, s });
        break;
    }
  }

  // 5. Ownership, in chronological order. The edge write comes first; the Document is merged
  //    only after it succeeds, so a rejected update leaves no trace.
  const ownership = fresh.filter((d) => d.data.kind === "ownership").sort((a, b) => ms((a.data as any).validFrom) - ms((b.data as any).validFrom));
  for (const d of ownership) {
    const x = d.data as Extract<Doc, { kind: "ownership" }>;
    const validFrom = ms(x.validFrom);
    if (!x.supersedes) {
      const r = await run(
        `MATCH (t:Team {id:$team}), (s:Service {id:$service})
         WHERE NOT (:Team)-[:OWNS]->(s)
         CREATE (t)-[:OWNS {validFrom:$validFrom, sourceId:$documentId}]->(s)
         RETURN s.id AS service`,
        { team: x.team, service: x.service, validFrom, documentId: x.id },
      );
      if (!r.data?.length) throw new IngestError(`${d.path}: ${x.service} already has an owner; a successor must set "supersedes"`);
      count(r);
    } else {
      const r = await run(
        `MATCH (oldTeam:Team)-[old:OWNS]->(s:Service {id:$serviceId})
         MATCH (newTeam:Team {id:$newTeamId})
         WHERE old.validTo IS NULL AND old.sourceId = $supersedesId
           AND old.validFrom < $newValidFrom AND oldTeam.id <> newTeam.id
         SET old.validTo = $newValidFrom
         CREATE (newTeam)-[:OWNS {validFrom:$newValidFrom, sourceId:$documentId}]->(s)
         RETURN oldTeam.id AS previousOwner, newTeam.id AS newOwner`,
        { serviceId: x.service, newTeamId: x.team, supersedesId: x.supersedes, newValidFrom: validFrom, documentId: x.id },
      );
      if (!r.data?.length) {
        throw new IngestError(`${d.path}: rejected ownership update for ${x.service}: "${x.supersedes}" must be the active record, ${x.validFrom} must be after it, and the team must change`);
      }
      count(r);
      result.ownershipClosed++;
    }
    count(await run(`MERGE (doc:Document {id:$id}) SET doc.path=$path, doc.hash=$hash, doc.title=$title, doc.ingestedAt=$ingestedAt`, docProps(d)));
  }

  result.documentsIngested = fresh.length;
  return result;
}
