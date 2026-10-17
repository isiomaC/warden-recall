import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ask, detectIntent, investigateIncident, type CompanyBrainAnswer } from "../src/agent/answer.ts";
import { connect, ensureIndexes, GraphUnavailableError, resetGraph, type Db, type Graph } from "../src/graph/client.ts";
import { ingestDocuments, loadDocuments } from "../src/ingestion/ingest.ts";

const NOW = Date.parse("2026-10-18T10:00:00Z");
const BEFORE_UPDATE = Date.parse("2026-10-15T12:00:00Z");
let db: Db;
let g: Graph;

const allClaims = (a: CompanyBrainAnswer) => a.sections.flatMap((s) => s.claims);
const section = (a: CompanyBrainAnswer, id: string) => a.sections.find((s) => s.id === id);
/** No fabricated provenance: every cited source id must resolve to a real Document in the answer. */
const expectCitationsResolve = (a: CompanyBrainAnswer) => {
  const known = new Set(a.sources.map((s) => s.id));
  for (const c of allClaims(a)) for (const id of c.sourceIds) expect(known.has(id), `unresolved source ${id}`).toBe(true);
};

beforeAll(async () => {
  db = await connect();
  g = await resetGraph(db, "test_answer");
  await ensureIndexes(g);
  await ingestDocuments(g, await loadDocuments("fixtures/northstar"));
});
afterAll(async () => {
  try { await g.delete(); } catch { /* ignore */ }
  await db.close();
});

describe("incident investigation before the ownership update", () => {
  let a: CompanyBrainAnswer;
  beforeAll(async () => { a = await ask(g, { preset: "investigate-incident", asOf: NOW }); });

  it("answers from the graph with impact, owners, projects and a proposal", () => {
    expect(a.status).toBe("ok");
    expect(a.headline).toMatch(/INC-102.*Payment Queue is failing.*3 dependent services.*Payments/);
    expect(section(a, "impact")!.claims.map((c) => c.claim.split(" depends")[0]).sort()).toEqual(["Checkout API", "Checkout Web", "Mobile App"]);
    expect(section(a, "projects")!.claims).toHaveLength(2);
    expect(section(a, "owners")!.claims.map((c) => c.claim.split(" (")[0]).sort()).toEqual([
      "Payments owns payment-queue", "Storefront owns checkout-api", "Storefront owns checkout-web", "Storefront owns mobile-app",
    ]);
    expect(a.proposal).toMatchObject({ incidentId: "inc-102", teamId: "payments", serviceIds: ["payment-queue"] });
  });

  it("on-call matches ownership, so no mismatch is raised", () => {
    expect(section(a, "oncall")).toMatchObject({ kind: "fact" });
  });

  it("every citation resolves; the Cypher and highlighted graph are returned", () => {
    expectCitationsResolve(a);
    expect(a.queries.map((q) => q.name)).toEqual(expect.arrayContaining(["Q1 impact paths", "Q2 owner as of time", "Q4 project impact", "Q-O on-call", "Q3 decision provenance"]));
    expect(a.queries.every((q) => q.cypher.length > 0)).toBe(true);
    expect(a.evidence.edges).toContainEqual({ from: "checkout-web", to: "checkout-api", type: "DEPENDS_ON" });
    expect(a.evidence.edges).toContainEqual({ from: "payments", to: "payment-queue", type: "OWNS" });
  });

  it("an unknown incident abstains instead of inventing one", async () => {
    const r = await investigateIncident(g, "inc-999", NOW);
    expect(r.status).toBe("abstain");
    expect(r.sections).toEqual([]);
  });

  it("a resolved incident produces no escalation proposal", async () => {
    const r = await ask(g, { question: "tell me about inc-101", asOf: NOW });
    expect(r.status).toBe("ok");
    expect(r.proposal).toBeUndefined();
  });
});

describe("decision provenance", () => {
  it("ADR-001 stays the rationale and ADR-002 is an amendment, never a supersession", async () => {
    const a = await ask(g, { preset: "why-queue", asOf: NOW });
    const text = allClaims(a).map((c) => c.claim).join("\n");
    expect(text).toMatch(/ADR-001.*amended by ADR-002.*still valid/);
    expect(text).toMatch(/ADR-002.*amends ADR-001/);
    expect(text.toLowerCase()).not.toContain("superseded");
    expect(a.sources.map((s) => s.id)).toEqual(["adr-001", "adr-002"]);
    expectCitationsResolve(a);
  });
});

describe("free-text questions", () => {
  it("'who owns checkout' is ambiguous and asks the user to choose", async () => {
    const a = await ask(g, { question: "Who owns checkout?", asOf: NOW });
    expect(a.status).toBe("disambiguation");
    expect(a.candidates!.map((c) => c.id)).toEqual(["checkout-api", "checkout-web"]);
    expect(a.sections).toEqual([]);
  });
  it("answering the disambiguation resolves the owner", async () => {
    const a = await ask(g, { question: "Who owns checkout?", serviceId: "checkout-api", intent: "owner", asOf: NOW });
    expect(a.headline).toMatch(/Storefront owns checkout-api/);
  });
  it("routes design questions to ADRs and resolves a multi-word service name", async () => {
    const a = await ask(g, { question: "Why was the payment queue introduced?", asOf: NOW });
    expect(a.intent).toBe("decisions");
    expect(a.headline).toContain("Payment Queue");
  });
  it("routes impact questions", async () => {
    const a = await ask(g, { question: "What breaks if billing worker fails?", asOf: NOW });
    expect(a.intent).toBe("impact");
    expect(a.headline).toMatch(/Billing Worker fails, 4 dependent services/);
  });
  it.each([
    ["Who is accountable for the billing worker?", "owner"],
    ["Who maintains the payment queue?", "owner"],
    ["Who should we page for checkout api?", "owner"],
    ["Who is in charge of the payment queue?", "owner"],
    ["What was the reason for the payment queue?", "decisions"],
    ["What was the rationale behind the retry design?", "decisions"],
    ["What is the blast radius if the payment queue is slow?", "impact"],
    ["What is downstream of billing worker?", "impact"],
    ["What relies on the payment queue?", "impact"],
    ["Is billing worker unavailable, what is stuck?", "impact"],
  ] as const)("routes the phrasing %j to %s", (q, intent) => { expect(detectIntent(q)).toBe(intent); });
  it("still abstains on phrasing it does not recognise", () => {
    for (const q of ["What's the weather in Dublin?", "Tell me a joke", "billing worker"]) expect(detectIntent(q)).toBeNull();
  });
  it("resolves the service when the new synonyms appear in the question", async () => {
    const a = await ask(g, { question: "Who is accountable for the billing worker?", asOf: NOW });
    expect(a.intent).toBe("owner");
    expect(a.headline).toMatch(/Payments owns billing-worker/);
    const b = await ask(g, { question: "What is the blast radius if billing worker is down?", asOf: NOW });
    expect(b.intent).toBe("impact");
    expect(b.headline).toContain("Billing Worker");
  });
  it("abstains on unsupported topics and unknown services rather than guessing", async () => {
    const weather = await ask(g, { question: "What's the weather in Dublin?", asOf: NOW });
    expect(weather.status).toBe("abstain");
    expect(weather.suggestions!.length).toBeGreaterThan(0);
    const ghost = await ask(g, { question: "Who owns the flux capacitor?", asOf: NOW });
    expect(ghost.status).toBe("abstain");
    expect(ghost.sections).toEqual([]);
    const empty = await ask(g, { question: "  ", asOf: NOW });
    expect(empty.status).toBe("abstain");
  });
  it("a forged service id abstains", async () => {
    const a = await ask(g, { question: "owner?", serviceId: "x' DETACH DELETE n //", intent: "owner", asOf: NOW });
    expect(a.status).toBe("abstain");
  });
});

describe("after the ownership update", () => {
  beforeAll(async () => { await ingestDocuments(g, await loadDocuments("fixtures/updates")); });

  it("the same investigation now reports the new owner and the new source", async () => {
    const a = await ask(g, { preset: "investigate-incident", asOf: NOW });
    expect(a.headline).toMatch(/owned by Commerce Reliability/);
    expect(a.proposal).toMatchObject({ teamId: "commerce-reliability", teamName: "Commerce Reliability" });
    const owners = section(a, "owners")!.claims.find((c) => c.entityIds[1] === "payment-queue")!;
    expect(owners.sourceIds).toEqual(["ownership-payment-queue-20261016"]);
    expectCitationsResolve(a);
  });

  it("flags that on-call did not follow ownership", async () => {
    const a = await ask(g, { preset: "investigate-incident", asOf: NOW });
    const oncall = section(a, "oncall")!;
    expect(oncall.kind).toBe("gap");
    expect(oncall.summary).toMatch(/Commerce Reliability.*Alex Rivera \(payments\).*does not transfer automatically/);
  });

  it("the historical clock still returns Payments, with its own source", async () => {
    const a = await ask(g, { preset: "investigate-incident", asOf: BEFORE_UPDATE });
    expect(a.proposal!.teamId).toBe("payments");
    const owner = section(a, "owners")!.claims.find((c) => c.entityIds[1] === "payment-queue")!;
    expect(owner.sourceIds).toEqual(["ownership-payment-queue-20261015"]);
  });

  it("the owner answer keeps Payments as history", async () => {
    const a = await ask(g, { preset: "who-owns", asOf: NOW });
    expect(a.headline).toMatch(/Commerce Reliability owns payment-queue \(since 2026-10-16\)/);
    expect(section(a, "history")!.claims.map((c) => c.claim)).toEqual([
      "Payments owned payment-queue from 2026-10-15 until 2026-10-16",
      "Commerce Reliability owned payment-queue from 2026-10-16 (current)",
    ]);
  });
});

describe("FalkorDB offline", () => {
  it("a dropped connection never crashes the process (the client emits 'error', which must have a listener)", async () => {
    let lost: Error | null = null;
    const tmp = await connect((e) => { lost = e; });
    expect(() => tmp.emit("error", new Error("socket closed unexpectedly"))).not.toThrow();
    expect((lost as Error | null)?.message).toBe("socket closed unexpectedly");
    await tmp.close();
  });
  it("fails closed: connecting to a dead port raises graph_unavailable", async () => {
    const prev = process.env.FALKORDB_PORT;
    process.env.FALKORDB_PORT = "1";
    try { await expect(connect()).rejects.toThrow(/graph_unavailable/); } finally { process.env.FALKORDB_PORT = prev ?? ""; if (!prev) delete process.env.FALKORDB_PORT; }
  });
  it("fails closed: a closed connection raises graph_unavailable and returns no answer", async () => {
    const tmp = await connect();
    const gg = tmp.selectGraph("test_answer");
    await tmp.close();
    await expect(ask(gg, { preset: "investigate-incident", asOf: NOW })).rejects.toBeInstanceOf(GraphUnavailableError);
  });
});
