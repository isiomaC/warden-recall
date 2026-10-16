import { investigateIncident } from "../agent/answer.ts";
import type { Graph } from "../graph/client.ts";
import { getIncident, getOwners } from "../graph/queries.ts";
import type { InvestigationMemory, InvestigationRefs, RecalledInvestigation } from "../integrations/memstack.ts";

/** The memory is always derived from a fresh graph answer on the server, never from client-supplied text. */
export async function saveInvestigation(g: Graph, mem: InvestigationMemory, input: { incidentId: string; sessionId: string; asOf: number }) {
  const answer = await investigateIncident(g, input.incidentId, input.asOf);
  if (answer.status !== "ok") return null;
  const { incident } = await getIncident(g, input.incidentId);
  const serviceId = incident!.services[0].id;
  const ownerClaim = answer.sections.find((s) => s.id === "owners")?.claims.find((c) => c.entityIds[1] === serviceId);
  const refs: InvestigationRefs = {
    incidentId: input.incidentId, serviceId,
    graphNodeIds: answer.evidence.nodes.map((n) => n.id),
    documentIds: answer.sources.map((s) => s.id),
    ownerTeamId: answer.proposal?.teamId ?? null,
    ownerTeamName: answer.proposal?.teamName ?? null,
    ownerSourceId: ownerClaim?.sourceIds[0] ?? null,
    asOf: answer.asOf,
  };
  const summary = `${answer.headline} Escalation target at the time: ${refs.ownerTeamName ?? "unknown"}.`;
  const saved = await mem.save({ sessionId: input.sessionId, summary, refs });
  return { id: saved.id, summary, refs };
}

export type RevalidatedMemory = RecalledInvestigation & {
  label: "remembered";
  stale: boolean;
  changes: string[];
  current: { ownerTeamId: string | null; ownerTeamName: string | null; ownerSourceId: string | null; asOf: string };
};

/** Recalled memories are context, not fact. Each is compared with the graph and flagged when it has gone stale. */
export async function recallInvestigations(g: Graph, mem: InvestigationMemory, input: { incidentId: string; asOf: number }): Promise<RevalidatedMemory[]> {
  const recalled = await mem.recall(input.incidentId);
  const out: RevalidatedMemory[] = [];
  for (const r of recalled) {
    const owner = (await getOwners(g, [r.refs.serviceId], input.asOf)).owners[0];
    const changes: string[] = [];
    if (owner.teamId !== r.refs.ownerTeamId) {
      changes.push(`Owner of ${r.refs.serviceId} changed from ${r.refs.ownerTeamName ?? "unknown"} to ${owner.teamName ?? "unknown"} (source: ${owner.sourceId ?? "none"}).`);
    }
    out.push({
      ...r, label: "remembered", stale: changes.length > 0, changes,
      current: { ownerTeamId: owner.teamId, ownerTeamName: owner.teamName, ownerSourceId: owner.sourceId, asOf: new Date(input.asOf).toISOString() },
    });
  }
  return out;
}
