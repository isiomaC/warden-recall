# Graph model

FalkorDB holds the company knowledge. Every node and edge is created by ingesting a Markdown document from `fixtures/`; there is no hand-written graph data.

## Nodes

| Label | Key properties | Source document |
|---|---|---|
| `Service` | `id`, `name`, `tier` | `fixtures/northstar/services/*.md` |
| `Team` | `id`, `name` | `teams/*.md` |
| `Person` | `id`, `name`, `role` | `people/*.md` |
| `Project` | `id`, `name` | `projects/*.md` |
| `ADR` | `id`, `title`, `date` | `adrs/*.md` |
| `Incident` | `id`, `title`, `severity`, `status`, `openedAt` | `incidents/*.md` |
| `Document` | `id`, `path`, `hash`, `title`, `ingestedAt` | every ingested file |
| `Ticket` | `id`, `title`, `status`, `createdAt`, `actor`, `decisionId` | created by an allowed escalation |

All timestamps are UTC epoch milliseconds.

## Relationships

| Relationship | Meaning |
|---|---|
| `(Service)-[:DEPENDS_ON]->(Service)` | `A DEPENDS_ON B`: A is impacted when B fails |
| `(Team)-[:OWNS {validFrom, validTo, sourceId}]->(Service)` | Temporal ownership. `[validFrom, validTo)`, absent `validTo` means open-ended. `sourceId` is a `Document.id` |
| `(Person)-[:MEMBER_OF]->(Team)` | Team membership |
| `(Person)-[:ON_CALL_FOR]->(Service)` | On-call assignment, separate from ownership |
| `(Project)-[:USES]->(Service)` | Business impact |
| `(Service)-[:HAS_DECISION]->(ADR)` | Architecture decisions |
| `(ADR)-[:AMENDS]->(ADR)` | An amendment changes one sub-decision and does not invalidate the ADR it amends |
| `(Incident)-[:AFFECTS]->(Service)` | What an incident hits |
| `(X)-[:DOCUMENTED_IN]->(Document)` | Provenance for every entity |
| `(Ticket)-[:ESCALATES]->(Incident)`, `(Ticket)-[:ASSIGNED_TO]->(Team)` | Created only after Warden allows |

## Ownership is a chain of custody

Ownership is a single canonical temporal edge. There is no separate "current owner" field. A new ownership document does two things in **one Cypher statement** (so it is atomic): it closes the active edge by setting `validTo`, and it creates the successor edge. The statement refuses to run unless the document's `supersedes` matches the active record, the new `validFrom` is later, and the team actually changes.

Querying with an as-of timestamp returns the current owner or any historical owner from the same edges.

## Indexes

An id index on every label and a full-text index on `Service.name`, used to resolve free-text questions to services. Ambiguous names return a choice instead of a guess.

## Pinned version

FalkorDB `v4.22.1`, pinned by image digest in `docker-compose.yml`. Node client: `falkordb` 6.8.
