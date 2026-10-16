# Warden Recall

An engineering "company brain" built on FalkorDB for the WeMakeDevs × FalkorDB Graph Hacks (Track 3: Company Brain).

Work in progress. Main development began after the hackathon start (Oct 15, 2026, 12:01 AM IST).

## Local setup

```sh
docker compose up -d      # FalkorDB v4.22.1 (pinned by digest)
pnpm install
pnpm test:graph-smoke     # verifies the Cypher features the app depends on
```
