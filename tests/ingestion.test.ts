import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, ensureIndexes, resetGraph, type Db, type Graph } from "../src/graph/client.ts";
import { findRelatedIncidents, findService, getDecisions, getIncident, getOnCall, getOwners, getProjectImpact, traceImpact } from "../src/graph/queries.ts";
import { IngestError, ingestDocuments, loadDocuments } from "../src/ingestion/ingest.ts";
import { parseDocumentText } from "../src/ingestion/parse-frontmatter.ts";

const NOW = Date.parse("2026-10-18T10:00:00Z");
const BEFORE_UPDATE = Date.parse("2026-10-15T12:00:00Z");

let db: Db;
let g: Graph;

const text = (front: string, body = "# Doc\n\nBody text.") => `---\n${front.trim()}\n---\n${body}`;
const doc = (front: string, path = "test.md") => parseDocumentText(path, text(front));
const ownerOf = async (service: string, asOf: number) => (await getOwners(g, [service], asOf)).owners[0];

beforeAll(async () => {
  db = await connect();
  g = await resetGraph(db, "test_ingestion");
  await ensureIndexes(g);
});
afterAll(async () => {
  try { await g.delete(); } catch { /* ignore */ }
  await db.close();
});

describe("frontmatter validation", () => {
  it("rejects missing frontmatter, unknown kinds, unknown fields, bad dates and empty bodies", () => {
    expect(() => parseDocumentText("a.md", "# no frontmatter")).toThrow(IngestError);
    expect(() => doc("id: x\nkind: wiki")).toThrow(/invalid frontmatter/);
    expect(() => doc("id: x\nkind: team\nname: X\nsurprise: 1")).toThrow(/invalid frontmatter/);
    expect(() => doc("id: o\nkind: ownership\nservice: s\nteam: t\nvalidFrom: not-a-date")).toThrow(/invalid frontmatter/);
    expect(() => parseDocumentText("a.md", "---\nid: x\nkind: team\nname: X\n---\n")).toThrow(/empty body/);
  });
});

describe("graph-level validation", () => {
  it("rejects dangling references, duplicate ids and dependency cycles before writing", async () => {
    await expect(ingestDocuments(g, [doc("id: a\nkind: service\nname: A\ntier: 1\ndependsOn: [ghost]")])).rejects.toThrow(/unknown Service "ghost"/);
    await expect(ingestDocuments(g, [doc("id: a\nkind: team\nname: A"), doc("id: a\nkind: team\nname: B")])).rejects.toThrow(/duplicate document id/);
    await expect(ingestDocuments(g, [
      doc("id: a\nkind: service\nname: A\ntier: 1\ndependsOn: [b]"),
      doc("id: b\nkind: service\nname: B\ntier: 1\ndependsOn: [a]"),
    ])).rejects.toThrow(/dependency cycle/);
    const n = (await g.query<{ c: number }>(`MATCH (n) RETURN count(n) AS c`)).data![0].c;
    expect(n).toBe(0);
  });
});

describe("seed and queries (before the ownership update)", () => {
  it("ingests the Northstar fixtures", async () => {
    const r = await ingestDocuments(g, await loadDocuments("fixtures/northstar"));
    expect(r.documentsIngested).toBe(21);
    expect(r.ownershipClosed).toBe(0);
  });

  it("Q1: payment-queue outage reaches checkout-api (1 hop), checkout-web and mobile-app (2 hops), not billing-worker", async () => {
    const { impacted, query } = await traceImpact(g, "payment-queue");
    expect(Object.fromEntries(impacted.map((i) => [i.id, i.hops]))).toEqual({ "checkout-api": 1, "checkout-web": 2, "mobile-app": 2 });
    const web = impacted.find((i) => i.id === "checkout-web")!;
    expect(web.evidence.edges).toEqual([
      { from: "checkout-web", to: "checkout-api", type: "DEPENDS_ON" },
      { from: "checkout-api", to: "payment-queue", type: "DEPENDS_ON" },
    ]);
    expect(query.params).toEqual({ serviceId: "payment-queue" });
  });

  it("Q1: a leaf dependent and an unknown service yield no impact", async () => {
    expect((await traceImpact(g, "checkout-web")).impacted).toEqual([]);
    expect((await traceImpact(g, "no-such-service")).impacted).toEqual([]);
  });

  it("Q2: every affected service has a source-backed owner; unknown services report unknown", async () => {
    const ids = ["payment-queue", "checkout-api", "checkout-web", "mobile-app"];
    const { owners } = await getOwners(g, [...ids, "no-such-service"], NOW);
    expect(owners.map((o) => [o.serviceId, o.teamId])).toEqual([
      ["payment-queue", "payments"], ["checkout-api", "storefront"], ["checkout-web", "storefront"], ["mobile-app", "storefront"], ["no-such-service", null],
    ]);
    expect(owners[0].sourceId).toBe("ownership-payment-queue-20261015");
    expect(owners[0].sourcePath).toContain("fixtures/northstar/ownership/payment-queue-20261015.md");
  });

  it("Q3: ADR-001 stays the rationale; ADR-002 amends it", async () => {
    const { decisions } = await getDecisions(g, "payment-queue");
    const [a1, a2] = decisions;
    expect(a1).toMatchObject({ id: "adr-001", amends: [], amendedBy: ["adr-002"], sourceId: "adr-001" });
    expect(a2).toMatchObject({ id: "adr-002", amends: ["adr-001"], amendedBy: [] });
  });

  it("Q4: both projects are impacted, each with USES evidence", async () => {
    const { projects } = await getProjectImpact(g, "payment-queue");
    expect(projects.map((p) => [p.projectId, p.hops]).sort()).toEqual([["holiday-checkout", 1], ["subscription-renewal", 0]]);
    const holiday = projects.find((p) => p.projectId === "holiday-checkout")!;
    expect(holiday.evidence.edges).toContainEqual({ from: "holiday-checkout", to: "checkout-api", type: "USES" });
  });

  it("Q5 and incident lookup", async () => {
    const { incidents } = await findRelatedIncidents(g, "payment-queue", "inc-102");
    expect(incidents.map((i) => i.id)).toEqual(["inc-101"]);
    const { incident } = await getIncident(g, "inc-102");
    expect(incident).toMatchObject({ status: "open", severity: "sev1", services: [{ id: "payment-queue", tier: 1 }] });
    expect((await getIncident(g, "inc-999")).incident).toBeNull();
  });

  it("Q6: 'checkout' is ambiguous, 'payment queue' resolves, junk resolves to nothing", async () => {
    const ambiguous = await findService(g, "checkout");
    expect(ambiguous.ambiguous).toBe(true);
    expect(ambiguous.candidates.map((c) => c.id)).toEqual(["checkout-api", "checkout-web"]);
    const one = await findService(g, "payment queue");
    expect(one.ambiguous).toBe(false);
    expect(one.candidates.map((c) => c.id)).toEqual(["payment-queue"]);
    expect((await findService(g, "zzzz")).candidates).toEqual([]);
    expect((await findService(g, '") OR @* (')).candidates).toEqual([]);
  });
});

describe("rejected ownership writes leave no trace", () => {
  const update = `id: ownership-payment-queue-bad
kind: ownership
service: payment-queue
team: commerce-reliability
validFrom: 2026-10-16T12:00:00Z`;
  const unchanged = async () => {
    expect((await ownerOf("payment-queue", NOW)).teamId).toBe("payments");
    const edges = (await g.query<{ c: number }>(`MATCH (:Team)-[o:OWNS]->(:Service {id:'payment-queue'}) RETURN count(o) AS c`)).data![0].c;
    expect(edges).toBe(1);
    const docs = (await g.query<{ c: number }>(`MATCH (d:Document {id:'ownership-payment-queue-bad'}) RETURN count(d) AS c`)).data![0].c;
    expect(docs).toBe(0);
  };

  it("wrong supersedes id", async () => {
    await expect(ingestDocuments(g, [doc(`${update}\nsupersedes: ownership-billing-worker-20261015`)])).rejects.toThrow(/rejected ownership update/);
    await unchanged();
  });
  it("same team", async () => {
    await expect(ingestDocuments(g, [doc(`${update.replace("commerce-reliability", "payments")}\nsupersedes: ownership-payment-queue-20261015`)])).rejects.toThrow(/rejected ownership update/);
    await unchanged();
  });
  it("update that is not newer than the active record", async () => {
    await expect(ingestDocuments(g, [doc(`${update.replace("2026-10-16T12:00:00Z", "2026-10-15T00:00:00Z")}\nsupersedes: ownership-payment-queue-20261015`)])).rejects.toThrow(/rejected ownership update/);
    await unchanged();
  });
  it("a first record for a service that already has an owner", async () => {
    await expect(ingestDocuments(g, [doc(update)])).rejects.toThrow(/already has an owner/);
    await unchanged();
  });
});

describe("live ownership update", () => {
  it("ingesting the update changes the current owner and keeps history", async () => {
    const before = await ownerOf("payment-queue", NOW);
    expect(before.teamId).toBe("payments");

    const r = await ingestDocuments(g, await loadDocuments("fixtures/updates"));
    expect(r).toMatchObject({ documentsIngested: 1, ownershipClosed: 1 });

    const now = await ownerOf("payment-queue", NOW);
    expect(now).toMatchObject({ teamId: "commerce-reliability", sourceId: "ownership-payment-queue-20261016" });
    const then = await ownerOf("payment-queue", BEFORE_UPDATE);
    expect(then).toMatchObject({ teamId: "payments", sourceId: "ownership-payment-queue-20261015" });
    expect(then.validTo).toBe(Date.parse("2026-10-16T12:00:00Z"));
  });

  it("exactly one owner is active at any instant, including the boundary", async () => {
    const boundary = Date.parse("2026-10-16T12:00:00Z");
    for (const t of [BEFORE_UPDATE, boundary - 1, boundary, NOW]) {
      const rows = (await g.query<{ c: number }>(
        `MATCH (:Team)-[o:OWNS]->(:Service {id:'payment-queue'}) WHERE o.validFrom <= $t AND (o.validTo IS NULL OR $t < o.validTo) RETURN count(o) AS c`, { params: { t } })).data![0].c;
      expect(rows).toBe(1);
    }
    expect((await ownerOf("payment-queue", boundary)).teamId).toBe("commerce-reliability");
    expect((await ownerOf("payment-queue", boundary - 1)).teamId).toBe("payments");
  });

  it("replaying the update is a no-op", async () => {
    const r = await ingestDocuments(g, await loadDocuments("fixtures/updates"));
    expect(r).toMatchObject({ documentsIngested: 0, documentsSkipped: 1, ownershipClosed: 0 });
    const edges = (await g.query<{ c: number }>(`MATCH (:Team)-[o:OWNS]->(:Service {id:'payment-queue'}) RETURN count(o) AS c`)).data![0].c;
    expect(edges).toBe(2);
  });

  it("changing a document under an existing id is rejected", async () => {
    const changed = parseDocumentText("fixtures/updates/payment-queue-20261016.md", text(
      "id: ownership-payment-queue-20261016\nkind: ownership\nservice: payment-queue\nteam: storefront\nvalidFrom: 2026-10-16T12:00:00Z\nsupersedes: ownership-payment-queue-20261015"));
    await expect(ingestDocuments(g, [changed])).rejects.toThrow(/immutable/);
  });

  it("on-call still points at Payments while ownership moved: the mismatch is detectable", async () => {
    const owner = await ownerOf("payment-queue", NOW);
    const { onCall } = await getOnCall(g, ["payment-queue"]);
    expect(onCall).toEqual([{ personId: "alex-oncall", personName: "Alex Rivera", teamId: "payments", serviceId: "payment-queue" }]);
    expect(onCall[0].teamId).not.toBe(owner.teamId);
  });
});
