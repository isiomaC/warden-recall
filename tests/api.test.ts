import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, graphProvider } from "../src/api/server.ts";

const provider = graphProvider("test_api");
const app = createApp(provider);
const NOW = "2026-10-18T10:00:00Z";
const json = async (path: string, init?: RequestInit) => {
  const res = await app.request(path, init);
  return { status: res.status, body: (await res.json()) as any };
};
const post = (path: string, body?: unknown) => json(path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ownersOf = (g: any, service: string) => g.edges.filter((e: any) => e.type === "OWNS" && e.to === service).map((e: any) => e.from);

beforeAll(async () => { await post("/api/reset"); });
afterAll(async () => {
  try { await (await provider.graph()).delete(); } catch { /* ignore */ }
  await provider.close();
});

describe("API: live freshness flow", () => {
  it("reset seeds the graph from Markdown", async () => {
    const r = await post("/api/reset");
    expect(r.status).toBe(200);
    expect(r.body.result.documentsIngested).toBe(21);
    const h = await json("/api/health");
    expect(h.body).toMatchObject({ status: "ok", graph: "test_api" });
    expect(h.body.nodes).toBeGreaterThan(20);
  });

  it("answers before the update: Payments owns the payment queue", async () => {
    const r = await post("/api/ask", { preset: "investigate-incident", asOf: NOW });
    expect(r.status).toBe(200);
    expect(r.body.proposal.teamId).toBe("payments");
    expect(r.body.queries.length).toBeGreaterThan(3);
  });

  it("the company graph shows exactly one effective owner per service", async () => {
    const g = (await json(`/api/graph?asOf=${NOW}`)).body;
    expect(ownersOf(g, "payment-queue")).toEqual(["payments"]);
    expect(g.nodes.some((n: any) => n.type === "Document")).toBe(false);
  });

  it("previews the pending update before it is applied", async () => {
    const p = (await json("/api/update-preview")).body.updates;
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ id: "ownership-payment-queue-20261016", applied: false });
    expect(p[0].content).toContain("Commerce Reliability assumes ownership");
  });

  it("ingesting the update live changes the answer and the graph, without a restart", async () => {
    const i = await post("/api/ingest-update");
    expect(i.status).toBe(200);
    expect(i.body.result).toMatchObject({ documentsIngested: 1, ownershipClosed: 1 });

    const a = (await post("/api/ask", { preset: "investigate-incident", asOf: NOW })).body;
    expect(a.proposal.teamId).toBe("commerce-reliability");
    expect(a.headline).toContain("Commerce Reliability");

    const g = (await json(`/api/graph?asOf=${NOW}`)).body;
    expect(ownersOf(g, "payment-queue")).toEqual(["commerce-reliability"]);
    const old = (await json("/api/graph?asOf=2026-10-15T12:00:00Z")).body;
    expect(ownersOf(old, "payment-queue")).toEqual(["payments"]);

    expect((await json("/api/update-preview")).body.updates[0].applied).toBe(true);
  });

  it("re-applying the update is a no-op", async () => {
    const i = await post("/api/ingest-update");
    expect(i.body.result).toMatchObject({ documentsIngested: 0, documentsSkipped: 1 });
  });
});

describe("API: sources and input handling", () => {
  it("serves the Markdown behind a citation", async () => {
    const s = await json("/api/source/adr-001");
    expect(s.status).toBe(200);
    expect(s.body.content).toContain("Introduce a durable Payment Queue");
    expect(s.body.path).toBe("fixtures/northstar/adrs/adr-001-queue-introduction.md");
  });
  it("only serves documents that exist in the graph", async () => {
    expect((await json("/api/source/nope")).status).toBe(404);
    expect((await json("/api/source/..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
  });
  it("rejects malformed requests and abstains on empty ones", async () => {
    expect((await post("/api/ask", { question: "x", surprise: true })).status).toBe(400);
    expect((await post("/api/ask", { preset: "nope" })).status).toBe(400);
    expect((await post("/api/ask", { question: "x".repeat(501) })).status).toBe(400);
    expect((await post("/api/ask", { asOf: "garbage", question: "who owns payment queue" })).status).toBe(400);
    expect((await json("/api/graph?asOf=garbage")).status).toBe(400);
    const empty = await post("/api/ask", {});
    expect(empty.status).toBe(200);
    expect(empty.body.status).toBe("abstain");
  });
});

describe("API: FalkorDB offline", () => {
  it("returns 503 graph_unavailable and no answer", async () => {
    const dead = createApp(graphProvider("test_api"));
    const prev = process.env.FALKORDB_PORT;
    process.env.FALKORDB_PORT = "1";
    try {
      const res = await dead.request("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset: "investigate-incident" }) });
      expect(res.status).toBe(503);
      const body = (await res.json()) as any;
      expect(body.error).toBe("graph_unavailable");
      expect(body.sections).toBeUndefined();
      expect((await dead.request("/api/ingest-update", { method: "POST" })).status).toBe(503);
    } finally {
      if (prev === undefined) delete process.env.FALKORDB_PORT; else process.env.FALKORDB_PORT = prev;
    }
  });
});
