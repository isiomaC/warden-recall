# Warden Recall

An engineering **company brain** built on FalkorDB, for the WeMakeDevs x FalkorDB Graph Hacks (Track 3: Company Brain).

During an incident, the hard questions cross systems, people and decisions: what is affected, who owns it *now*, why was it built this way, who do we escalate to. Warden Recall answers them by walking a FalkorDB graph that is built from Markdown documents, and it shows its work: the exact graph path, the parameterized Cypher, and the source document behind every claim.

It is not a chat-with-documents app. The point of the demo is that **the answer changes correctly when a new document arrives**.

## What it does

- **Ingests Markdown into a graph.** Services, teams, people, projects, ADRs, incidents and ownership records are parsed from YAML-frontmatter Markdown, validated with Zod, and written to FalkorDB in two passes. Ingestion is idempotent and rejects dangling references, cycles and invalid ownership chronology.
- **Answers from the graph.** Multi-hop impact (dependents of a failed service), ownership as of a point in time, decision provenance, project impact and related incidents. Every claim cites real source documents; unknown or unsupported questions abstain instead of guessing.
- **Handles change.** Ownership is a temporal edge. Ingesting a newer ownership document closes the old interval and opens the new one in a single atomic Cypher statement; the same question then returns the new owner, while the earlier owner stays in the custody history and remains queryable as of earlier times.
- **Notices what did not change with it.** After the ownership transfer, on-call still points at the old team. The answer calls that out.
- **Acts under policy.** Escalations are authorized by the [`@stlw/warden`](https://www.npmjs.com/package/@stlw/warden) policy engine: an SRE may escalate an open incident on a tier-1 service, an intern may not, and every decision lands in a hash-chained audit log. A deny writes nothing.
- **Remembers, without trusting memory.** Investigation summaries are stored with [`@memstack/core`](https://www.npmjs.com/package/@memstack/core). In a new session they are recalled, labelled as memory, and compared with the graph: if the owner changed since, the memory is flagged out of date and the graph wins.
- **Fails closed.** If FalkorDB is down the API returns `503 graph_unavailable`; there is no cached or canned fallback.

## Quick start

Requires Docker, Node 24 and pnpm.

```sh
docker compose up -d          # FalkorDB v4.22.1, pinned by digest
pnpm install
pnpm demo:seed                # ingest fixtures/northstar into the graph
pnpm start                    # builds the UI and serves everything on http://localhost:8787
```

For development with hot reload: `pnpm dev` (API on :8787, UI on :5173).

No API keys or external accounts are needed. All data is synthetic.

### The demo, in order

1. Click **"Checkout is down. What is affected, who owns it, who do we escalate to?"**. The answer lists the affected services (multi-hop), their owners, projects at risk, on-call and decisions. The graph highlights exactly the paths used, and the inspector below shows the Cypher, the cited sources and the text paths.
2. In the right rail, click **Ingest this document**. A new ownership Markdown file goes through the same pipeline as the seed. The answer updates, the custody strip shows Payments transferred to Commerce Reliability, and the new `OWNS` edge is drawn on the graph.
3. **Propose escalation**, then confirm as `intern` (denied, no ticket) and as `sre` (allowed, one ticket).
4. **Save investigation**, then **New session** to see the memory recalled and checked against the graph.
5. **Reset demo** wipes the graph and the saved memories and reseeds, so you can run it again.

Set `DEMO_AS_OF=2026-10-18T10:00:00Z` for a deterministic clock.

## Tests

```sh
pnpm test                     # unit and integration tests; needs the FalkorDB container running
pnpm test:e2e                 # drives the real UI in Chrome against the real API (stops and restarts FalkorDB once)
pnpm typecheck
```

The integration tests run against a real FalkorDB: graph features, ingestion rules, answer assembly, the HTTP API, Warden policy decisions and the audit chain, MemStack recall and staleness, demo reset, and the fail-closed behavior when FalkorDB or the policy engine is unavailable. The end-to-end tests cover the user-visible flows: asking and the evidence behind answers, the live ownership update, escalation allow and deny, memory and stale detection, narrow screens, dark mode, and a FalkorDB outage with recovery.

## Documentation

- [Graph model](docs/GRAPH_MODEL.md)
- [Key Cypher queries](docs/QUERIES.md)
- [Reuse and AI disclosure](docs/REUSE_AND_AI.md)

## Repository layout

```text
fixtures/northstar/   synthetic company as Markdown (services, teams, people, ownership, ADRs, incidents, projects)
fixtures/updates/     the pending ownership document ingested live in the demo
src/ingestion/        frontmatter parsing, Zod schemas, two-pass idempotent ingest
src/graph/            FalkorDB client, parameterized queries, evidence paths
src/agent/            answer assembly, free-text routing, presets
src/actions/          escalation (Warden-gated) and investigation memory
src/integrations/     Warden and MemStack adapters
src/api/              Hono API
web/                  React + Vite UI
tests/                integration tests
```

## Limitations

- Question understanding is deterministic: presets plus keyword routing and full-text service resolution (see `docs/QUERIES.md`, "Question routing"). There is no LLM in the loop, by design, so answers cannot invent graph facts. Phrasing outside the known keywords gets an abstain with suggested questions.
- The company is synthetic and small (5 services, 3 teams, 2 people). Queries are bounded (depth 4) and written for clarity, not benchmarked at scale.
- The demo clock defaults to the current time. Ownership changes are effective from the document's `validFrom`.
