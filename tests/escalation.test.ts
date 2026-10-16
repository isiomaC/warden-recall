import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, graphProvider, type Services } from "../src/api/server.ts";
import { createMemStackMemory } from "../src/integrations/memstack.ts";
import { createWardenPolicyAuthority } from "../src/integrations/warden.ts";

const NOW = "2026-10-18T10:00:00Z";
const provider = graphProvider("test_escalation");
let dir: string;
let app: ReturnType<typeof createApp>;
let services: Services;

const call = async (path: string, init?: RequestInit) => {
  const res = await app.request(path, init);
  return { status: res.status, body: (await res.json()) as any };
};
const post = (path: string, body?: unknown) => call(path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const countTickets = async () => (await (await provider.graph()).query<{ c: number }>(`MATCH (t:Ticket) RETURN count(t) AS c`)).data![0].c;
const propose = async (incidentId = "inc-102") => (await post("/api/escalation/propose", { incidentId, asOf: NOW })).body;
const submit = (draftId: string, actor: string, extra: Record<string, unknown> = {}) =>
  post("/api/escalation/submit", { incidentId: "inc-102", draftId, actor, confirm: true, asOf: NOW, ...extra });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "recall-mem-"));
  services = { policy: createWardenPolicyAuthority(), memory: createMemStackMemory(dir) };
  app = createApp(provider, services);
  await post("/api/reset");
});
afterAll(async () => {
  try { await (await provider.graph()).delete(); } catch { /* ignore */ }
  await provider.close();
  await rm(dir, { recursive: true, force: true });
});

describe("escalation draft", () => {
  it("is derived from the graph: current owner, open sev1 incident, tier-1 service", async () => {
    const { draft } = await propose();
    expect(draft).toMatchObject({ incidentId: "inc-102", teamId: "payments", teamName: "Payments", status: "open", severity: "sev1", minServiceTier: 1, serviceIds: ["payment-queue"] });
    expect(draft.ownerSourceId).toBe("ownership-payment-queue-20261015");
  });
  it("unknown incidents are 404", async () => {
    expect((await post("/api/escalation/propose", { incidentId: "inc-999" })).status).toBe(404);
  });
});

describe("Warden denies: nothing is written", () => {
  let draftId: string;
  beforeAll(async () => { draftId = (await propose()).draft.draftId; });

  it("requires explicit confirmation", async () => {
    const r = await submit(draftId, "sre", { confirm: false });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("confirmation_required");
    expect(await countTickets()).toBe(0);
  });
  it("denies the intern with a reason and a decision id, and creates no ticket", async () => {
    const r = await submit(draftId, "intern");
    expect(r.status).toBe(403);
    expect(r.body.ticket).toBeNull();
    expect(r.body.decision).toMatchObject({ effect: "deny", policyId: "escalation-policy", matchedRules: ["deny-intern"] });
    expect(r.body.decision.reason).toMatch(/interns may not escalate/);
    expect(r.body.decision.decisionId).toMatch(/^[0-9a-f]{16}$/);
    expect(await countTickets()).toBe(0);
  });
  it("denies unknown and forged actors", async () => {
    for (const actor of ["root", "SRE", "sre'; MATCH (n) DETACH DELETE n //", ""]) {
      const r = await submit(draftId, actor);
      expect(r.status, actor).toBe(403);
      expect(r.body.decision.effect).toBe("deny");
    }
    expect(await countTickets()).toBe(0);
  });
  it("denies an sre on a resolved incident (not open)", async () => {
    const d = (await propose("inc-101")).draft;
    expect(d.status).toBe("resolved");
    const r = await post("/api/escalation/submit", { incidentId: "inc-101", draftId: d.draftId, actor: "sre", confirm: true, asOf: NOW });
    expect(r.status).toBe(403);
    expect(r.body.decision.reason).toMatch(/default deny/);
    expect(await countTickets()).toBe(0);
  });
  it("fails closed when the policy authority breaks", async () => {
    const broken = createApp(provider, { ...services, policy: { evaluate: async () => { throw new Error("warden down"); }, audit: services.policy.audit } });
    const res = await broken.request("/api/escalation/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ incidentId: "inc-102", draftId, actor: "sre", confirm: true, asOf: NOW }) });
    const body = (await res.json()) as any;
    expect(res.status).toBe(403);
    expect(body.decision.reason).toMatch(/policy unavailable: warden down/);
    expect(await countTickets()).toBe(0);
  });
  it("rejects a draft id that does not match the graph", async () => {
    const r = await submit("deadbeef0000", "sre");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("stale_draft");
    expect(await countTickets()).toBe(0);
  });
});

describe("Warden allows: exactly one ticket", () => {
  let draftId: string;
  beforeAll(async () => { draftId = (await propose()).draft.draftId; });

  it("creates the ticket and links it to the incident and the owning team in the graph", async () => {
    const r = await submit(draftId, "sre");
    expect(r.status).toBe(200);
    expect(r.body.decision).toMatchObject({ effect: "allow", matchedRules: ["allow-sre-open-tier1"] });
    expect(r.body.duplicate).toBe(false);
    expect(r.body.ticket).toMatchObject({ incidentId: "inc-102", teamId: "payments", status: "open", actor: "sre", decisionId: r.body.decision.decisionId });
    const edges = (await (await provider.graph()).query<{ i: string; t: string }>(
      `MATCH (:Ticket {id:$id})-[:ESCALATES]->(i:Incident), (:Ticket {id:$id})-[:ASSIGNED_TO]->(t:Team) RETURN i.id AS i, t.id AS t`, { params: { id: r.body.ticket.id } })).data;
    expect(edges).toEqual([{ i: "inc-102", t: "payments" }]);
  });
  it("is idempotent: a retry returns the same ticket and creates no second one", async () => {
    const first = (await call("/api/tickets?incidentId=inc-102")).body.tickets[0];
    const r = await submit(draftId, "sre");
    expect(r.status).toBe(200);
    expect(r.body.duplicate).toBe(true);
    expect(r.body.ticket.id).toBe(first.id);
    expect(await countTickets()).toBe(1);
  });
  it("records every decision in a verifiable hash chain", async () => {
    const audit = (await call("/api/audit")).body;
    expect(audit.verification).toEqual({ valid: true, entries: audit.entries.length });
    const effects = audit.entries.map((e: any) => e.event.payload.effect);
    expect(effects).toContain("allow");
    // intern, four forged actors, and the resolved incident; stale drafts and a broken authority never reach the chain
    expect(effects.filter((e: string) => e === "deny")).toHaveLength(6);
    const tampered = structuredClone(audit.entries);
    tampered[0].event.payload.effect = "allow";
    const { verifyAuditChain } = await import("@stlw/warden");
    expect(verifyAuditChain(tampered).valid).toBe(false);
  });
});

describe("MemStack: cross-session memory", () => {
  it("saves an investigation derived from the graph, not from client text", async () => {
    const forged = await post("/api/memory/save", { incidentId: "inc-102", sessionId: "s1", summary: "Payments owns nothing" });
    expect(forged.status).toBe(400);
    const r = await post("/api/memory/save", { incidentId: "inc-102", sessionId: "session-one", asOf: NOW });
    expect(r.status).toBe(200);
    expect(r.body.saved.summary).toMatch(/INC-102.*Payment Queue is failing.*Escalation target at the time: Payments/);
    expect(r.body.saved.refs).toMatchObject({ serviceId: "payment-queue", ownerTeamId: "payments", ownerSourceId: "ownership-payment-queue-20261015" });
    expect(r.body.saved.refs.graphNodeIds).toContain("checkout-web");
    expect(r.body.saved.refs.documentIds).toContain("adr-001");
  });
  it("a new session recalls it, labelled as remembered and not stale while the graph is unchanged", async () => {
    const { body } = await call(`/api/memory?incidentId=inc-102&asOf=${NOW}`);
    expect(body.memories).toHaveLength(1);
    expect(body.memories[0]).toMatchObject({ label: "remembered", stale: false, sessionId: "session-one", changes: [] });
  });
  it("does not leak memories across incidents and validates input", async () => {
    expect((await call(`/api/memory?incidentId=inc-101&asOf=${NOW}`)).body.memories).toEqual([]);
    expect((await post("/api/memory/save", { incidentId: "inc-102", sessionId: "bad session!" })).status).toBe(400);
    expect((await post("/api/memory/save", { incidentId: "inc-999", sessionId: "s2" })).status).toBe(404);
  });
});

describe("after the ownership update", () => {
  beforeAll(async () => { expect((await post("/api/ingest-update")).status).toBe(200); });

  it("the old draft is stale and cannot be submitted", async () => {
    const stale = (await call("/api/tickets?incidentId=inc-102")).body.tickets[0];
    const r = await submit("anything", "sre");
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/Commerce Reliability/);
    expect((await call("/api/tickets?incidentId=inc-102")).body.tickets).toEqual([stale]);
  });
  it("a new draft targets the new owner and creates a distinct ticket", async () => {
    const { draft } = await propose();
    expect(draft).toMatchObject({ teamId: "commerce-reliability", ownerSourceId: "ownership-payment-queue-20261016" });
    const r = await submit(draft.draftId, "sre");
    expect(r.status).toBe(200);
    expect(r.body.ticket.teamId).toBe("commerce-reliability");
    expect(r.body.tickets.map((t: any) => t.teamId).sort()).toEqual(["commerce-reliability", "payments"]);
  });
  it("the remembered investigation is flagged stale and the graph wins", async () => {
    const { body } = await call(`/api/memory?incidentId=inc-102&asOf=${NOW}`);
    const m = body.memories[0];
    expect(m.stale).toBe(true);
    expect(m.changes[0]).toMatch(/changed from Payments to Commerce Reliability.*ownership-payment-queue-20261016/);
    expect(m.current).toMatchObject({ ownerTeamId: "commerce-reliability", ownerSourceId: "ownership-payment-queue-20261016" });
    expect(m.summary).toContain("Payments");
  });
});

describe("degraded dependencies", () => {
  it("a MemStack failure degrades memory only; graph answers still work", async () => {
    const boom = createApp(provider, { ...services, memory: { save: async () => { throw new Error("disk full"); }, recall: async () => { throw new Error("disk gone"); } } });
    const save = await boom.request("/api/memory/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ incidentId: "inc-102", sessionId: "s9" }) });
    expect(save.status).toBe(503);
    expect(((await save.json()) as any).error).toBe("memory_unavailable");
    const recall = await boom.request("/api/memory?incidentId=inc-102");
    expect(recall.status).toBe(503);
    expect(((await recall.json()) as any).memories).toEqual([]);
    const ask = await boom.request("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset: "who-owns", asOf: NOW }) });
    expect(ask.status).toBe(200);
  });
  it("FalkorDB offline: escalation and memory fail closed with 503", async () => {
    const dead = createApp(graphProvider("test_escalation"), services);
    const prev = process.env.FALKORDB_PORT;
    process.env.FALKORDB_PORT = "1";
    try {
      const sub = await dead.request("/api/escalation/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ incidentId: "inc-102", draftId: "x", actor: "sre", confirm: true }) });
      expect(sub.status).toBe(503);
      expect(((await sub.json()) as any).error).toBe("graph_unavailable");
      expect((await dead.request("/api/memory?incidentId=inc-102")).status).toBe(503);
    } finally {
      if (prev === undefined) delete process.env.FALKORDB_PORT; else process.env.FALKORDB_PORT = prev;
    }
  });
});
