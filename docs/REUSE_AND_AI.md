# Reuse and AI disclosure

## New work in this repository

Everything in this repository was written during the hackathon, after the official start (2026-10-15 00:01 IST): the Markdown ingestion pipeline, the FalkorDB graph model and queries, the answer assembly, the HTTP API, the Warden and MemStack adapters, the escalation and memory logic, the web UI, the synthetic Northstar Commerce fixtures and the tests. The commit history shows the work.

## Reused dependencies (disclosed)

- **`@stlw/warden` 0.2.8** (npm, published 2026-10-09, a policy engine by the same author) is used as a dependency to make the escalation authorization decisions and keep a hash-chained audit log. Our code defines the escalation policy and the adapter in `src/integrations/warden.ts`.
- **`@memstack/core` 0.8.5** (npm, published 2026-10-08, a memory library by the same author) is used as a dependency to persist and recall investigation summaries. Our code is the adapter and the staleness check in `src/integrations/memstack.ts` and `src/actions/memory.ts`.
- Open-source libraries: FalkorDB and its Node client, Hono, Zod, yaml, React, Vite, React Flow (`@xyflow/react`), dagre, Geist fonts, Phosphor icons, Vitest.

FalkorDB is the primary database and the core of the product. Without it, answers, ownership history and escalation context are unavailable, and the app reports `graph_unavailable` rather than substituting anything.

## Data

All data is synthetic (a fictional company, "Northstar Commerce"). No private, personal or login-protected data is used.

## AI-assisted development

AI coding assistants were used while building this project. The author reviewed the code and can explain the graph model, the queries, the architecture and the decisions. The tests (run with `pnpm test` against a real FalkorDB) cover the graph queries, the ingestion rules, the answer assembly, the API, the Warden policy and the MemStack behavior.
