import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FalkorDB } from "falkordb";

const HOST = process.env.FALKORDB_HOST ?? "localhost";
const PORT = Number(process.env.FALKORDB_PORT ?? 6379);

let db: Awaited<ReturnType<typeof FalkorDB.connect>>;
let g: ReturnType<typeof db.selectGraph>;

beforeAll(async () => {
  db = await FalkorDB.connect({ socket: { host: HOST, port: PORT } });
  g = db.selectGraph("smoke");
  try { await g.delete(); } catch { /* graph did not exist */ }
  await g.query(`
    CREATE (w:Service {id:'checkout-web', name:'Checkout Web'}),
           (a:Service {id:'checkout-api', name:'Checkout API'}),
           (m:Service {id:'mobile-app', name:'Mobile App'}),
           (q:Service {id:'payment-queue', name:'Payment Queue'}),
           (b:Service {id:'billing-worker', name:'Billing Worker'}),
           (w)-[:DEPENDS_ON]->(a), (m)-[:DEPENDS_ON]->(a),
           (a)-[:DEPENDS_ON]->(q), (q)-[:DEPENDS_ON]->(b),
           (pay:Team {id:'payments'}), (cr:Team {id:'commerce-reliability'}),
           (d1:Document {id:'ownership-payment-queue-20261015'}),
           (pay)-[:OWNS {validFrom:1760486400000, sourceId:'ownership-payment-queue-20261015'}]->(q)`);
});

afterAll(async () => {
  try { await g.delete(); } catch { /* ignore */ }
  await db.close();
});

describe("Q1 impact paths (incoming DEPENDS_ON)", () => {
  it("returns dependents of payment-queue with correct hop counts and direction", async () => {
    const r = await g.query<{ id: string; hops: number; nodes: unknown[]; edges: unknown[] }>(
      `MATCH p=(dep:Service)-[:DEPENDS_ON*1..4]->(f:Service {id:$id})
       RETURN dep.id AS id, length(p) AS hops, nodes(p) AS nodes, relationships(p) AS edges`,
      { params: { id: "payment-queue" } },
    );
    const byId = Object.fromEntries((r.data ?? []).map((x) => [x.id, x.hops]));
    expect(byId).toEqual({ "checkout-api": 1, "checkout-web": 2, "mobile-app": 2 });
    expect(byId["billing-worker"]).toBeUndefined();
    expect((r.data ?? [])[0].nodes.length).toBeGreaterThan(0);
    expect((r.data ?? [])[0].edges.length).toBeGreaterThan(0);
  });
});

describe("Q2 temporal ownership with epoch ms and absent validTo", () => {
  const q = `MATCH (t:Team)-[o:OWNS]->(s:Service {id:$id})
             WHERE o.validFrom <= $asOf AND (o.validTo IS NULL OR $asOf < o.validTo)
             MATCH (d:Document) WHERE d.id = o.sourceId
             RETURN t.id AS team, d.id AS doc`;
  it("absent validTo counts as open-ended", async () => {
    const r = await g.query<{ team: string }>(q, { params: { id: "payment-queue", asOf: 1760918400000 } });
    expect(r.data?.map((x) => x.team)).toEqual(["payments"]);
  });
});

describe("Q-W ownership successor (single atomic statement)", () => {
  const UPDATE_FROM = Date.parse("2026-10-16T12:00:00Z");
  const succ = `MATCH (oldTeam:Team)-[old:OWNS]->(s:Service {id:$serviceId})
    MATCH (newTeam:Team {id:$newTeamId})
    WHERE old.validTo IS NULL AND old.sourceId = $supersedesId
      AND old.validFrom < $newValidFrom AND oldTeam.id <> newTeam.id
    SET old.validTo = $newValidFrom
    CREATE (newTeam)-[:OWNS {validFrom:$newValidFrom, sourceId:$documentId}]->(s)
    RETURN oldTeam.id AS previousOwner, newTeam.id AS newOwner`;
  const base = { serviceId: "payment-queue", newTeamId: "commerce-reliability", newValidFrom: UPDATE_FROM, documentId: "ownership-payment-queue-20261016" };
  const owners = async (asOf: number) =>
    (await g.query<{ team: string }>(
      `MATCH (t:Team)-[o:OWNS]->(:Service {id:'payment-queue'})
       WHERE o.validFrom <= $asOf AND (o.validTo IS NULL OR $asOf < o.validTo) RETURN t.id AS team`,
      { params: { asOf } })).data?.map((x) => x.team);

  it("a wrong supersedes id changes nothing", async () => {
    const r = await g.query(succ, { params: { ...base, supersedesId: "wrong-id" } });
    expect(r.data ?? []).toHaveLength(0);
    expect(await owners(Date.parse("2026-10-18T10:00:00Z"))).toEqual(["payments"]);
  });
  it("same-team update is rejected", async () => {
    const r = await g.query(succ, { params: { ...base, newTeamId: "payments", supersedesId: "ownership-payment-queue-20261015" } });
    expect(r.data ?? []).toHaveLength(0);
  });
  it("valid successor closes the old edge and opens the new one", async () => {
    const r = await g.query<{ previousOwner: string; newOwner: string }>(succ, { params: { ...base, supersedesId: "ownership-payment-queue-20261015" } });
    expect(r.data).toEqual([{ previousOwner: "payments", newOwner: "commerce-reliability" }]);
    expect(await owners(Date.parse("2026-10-18T10:00:00Z"))).toEqual(["commerce-reliability"]);
    expect(await owners(Date.parse("2026-10-15T12:00:00Z"))).toEqual(["payments"]);
  });
  it("replay finds no active edge with that supersedes id", async () => {
    const r = await g.query(succ, { params: { ...base, supersedesId: "ownership-payment-queue-20261015" } });
    expect(r.data ?? []).toHaveLength(0);
  });
});

describe("Q6 full-text service resolution", () => {
  it("indexes Service.name and returns ambiguous and near matches", async () => {
    await g.query(`CALL db.idx.fulltext.createNodeIndex('Service', 'name')`);
    const q = async (term: string) =>
      (await g.query<{ id: string }>(
        `CALL db.idx.fulltext.queryNodes('Service', $term) YIELD node RETURN node.id AS id`,
        { params: { term } })).data?.map((x) => x.id).sort();
    expect(await q("checkout")).toEqual(["checkout-api", "checkout-web"]);
    expect(await q("payment")).toEqual(["payment-queue"]);
  });
});
