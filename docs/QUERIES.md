# Key Cypher queries

All queries are parameterized and live in `src/graph/queries.ts` (the ingestion writes are in `src/ingestion/ingest.ts`). User text is never interpolated into Cypher. The UI shows the exact text and parameters of every query behind an answer.

## Impact: dependents of the failed service (multi-hop)

```cypher
MATCH p=(dep:Service)-[:DEPENDS_ON*1..4]->(failed:Service {id:$serviceId})
RETURN dep.id AS id, dep.name AS name, length(p) AS hops, nodes(p) AS nodes, relationships(p) AS edges
ORDER BY hops, id LIMIT 25
```

Direction matters: `A DEPENDS_ON B` means A is impacted when B fails. For `payment-queue` this returns `checkout-api` (1 hop), and `checkout-web` and `mobile-app` (2 hops), and not `billing-worker`.

## Owner as of a point in time, with its source

```cypher
MATCH (t:Team)-[o:OWNS]->(s:Service)
WHERE s.id IN $serviceIds AND o.validFrom <= $asOf AND (o.validTo IS NULL OR $asOf < o.validTo)
MATCH (d:Document) WHERE d.id = o.sourceId
RETURN s.id AS serviceId, t.id AS teamId, t.name AS teamName, o.validFrom AS validFrom, o.validTo AS validTo, d.id AS sourceId, d.path AS sourcePath
```

Vary `$asOf` to get the owner before or after an ownership document was ingested.

## Ownership successor (one atomic write)

```cypher
MATCH (oldTeam:Team)-[old:OWNS]->(s:Service {id:$serviceId})
MATCH (newTeam:Team {id:$newTeamId})
WHERE old.validTo IS NULL
  AND old.sourceId = $supersedesId
  AND old.validFrom < $newValidFrom
  AND oldTeam.id <> newTeam.id
SET old.validTo = $newValidFrom
CREATE (newTeam)-[:OWNS {validFrom:$newValidFrom, sourceId:$documentId}]->(s)
RETURN oldTeam.id AS previousOwner, newTeam.id AS newOwner
```

If nothing matches, nothing is written and ingestion reports why.

## Decision provenance

```cypher
MATCH (s:Service {id:$serviceId})-[:HAS_DECISION]->(a:ADR)-[:DOCUMENTED_IN]->(d:Document)
OPTIONAL MATCH (a)-[:AMENDS]->(older:ADR)
OPTIONAL MATCH (newer:ADR)-[:AMENDS]->(a)
RETURN a.id AS id, a.title AS title, a.date AS date, d.id AS sourceId, d.path AS sourcePath,
       collect(DISTINCT older.id) AS amends, collect(DISTINCT newer.id) AS amendedBy
ORDER BY date
```

## Project impact

```cypher
MATCH (pr:Project)-[u:USES]->(s:Service)
MATCH p=(s)-[:DEPENDS_ON*0..4]->(f:Service {id:$serviceId})
RETURN pr.id AS projectId, pr.name AS projectName, s.id AS serviceId, length(p) AS hops, nodes(p) AS nodes, relationships(p) AS edges
ORDER BY hops, projectId
```

## Question routing (no LLM)

Free-text questions are routed by `detectIntent` in `src/agent/answer.ts`, which is deterministic. It checks keyword groups in a fixed order: **decisions** (why, rationale, reason, decided, design, ADR), then **owner** (who owns, accountable, maintains, on-call, escalate, in charge, who to page), then **impact** (affected, breaks, blast radius, downstream, depends, relies, down, slow). The first group that matches picks the query. Words that only signal intent are removed before the service name is resolved with the full-text index below.

If no group matches, or no service matches, the app abstains and suggests the supported questions instead of guessing. An ambiguous service name returns a choice. The model is never asked to pick a query or write one, so an answer can only contain facts the graph returned. The preset questions in the UI skip routing and run their query directly.

## Service resolution (full-text)

```cypher
CALL db.idx.fulltext.queryNodes('Service', $term) YIELD node
RETURN node.id AS id, node.name AS name, node.tier AS tier ORDER BY node.id LIMIT 5
```

The index is created with `CALL db.idx.fulltext.createNodeIndex('Service', 'name')`. Tokens are stripped of query syntax and prefix-matched.

## On-call, related incidents, ownership history

See `getOnCall`, `findRelatedIncidents` and `getOwnershipHistory` in `src/graph/queries.ts`.

## Escalation ticket (idempotent)

```cypher
MATCH (i:Incident {id:$incidentId}), (tm:Team {id:$teamId})
MERGE (t:Ticket {id:$ticketId})
ON CREATE SET t.status = 'open', t.createdAt = $now, t.title = $title, t.actor = $actor, t.decisionId = $decisionId
MERGE (t)-[:ESCALATES]->(i)
MERGE (t)-[:ASSIGNED_TO]->(tm)
```

The ticket id is derived from the incident and team, so a retry returns the same ticket. It only runs after Warden allows.
