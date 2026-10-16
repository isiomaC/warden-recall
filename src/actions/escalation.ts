import { createHash } from "node:crypto";
import type { Graph } from "../graph/client.ts";
import { getIncident, getOwners } from "../graph/queries.ts";
import type { PolicyAuthority, PolicyDecision } from "../integrations/warden.ts";

export type EscalationErrorCode = "incident_not_found" | "no_owner" | "stale_draft" | "confirmation_required";
export class EscalationError extends Error {
  readonly code: EscalationErrorCode;
  constructor(code: EscalationErrorCode, message: string) { super(message); this.code = code; }
}

export type EscalationDraft = {
  draftId: string;
  incidentId: string;
  incidentTitle: string;
  severity: string;
  status: string;
  teamId: string;
  teamName: string;
  ownerSourceId: string;
  serviceIds: string[];
  minServiceTier: number;
  asOf: string;
};
export type Ticket = { id: string; incidentId: string; teamId: string; title: string; status: string; createdAt: number; actor: string; decisionId: string };

/** A draft is derived entirely from the graph. Its id changes if the incident or the current owner changes. */
export async function buildDraft(g: Graph, incidentId: string, asOf: number): Promise<EscalationDraft> {
  const { incident } = await getIncident(g, incidentId);
  if (!incident) throw new EscalationError("incident_not_found", `Unknown incident "${incidentId}".`);
  const failed = incident.services[0];
  const owner = (await getOwners(g, [failed.id], asOf)).owners[0];
  if (!owner.teamId || !owner.sourceId) throw new EscalationError("no_owner", `No source-backed owner is effective for ${failed.id}, so there is no one to escalate to.`);
  const draftId = createHash("sha256").update([incident.id, incident.status, owner.teamId, owner.sourceId].join("|")).digest("hex").slice(0, 12);
  return {
    draftId, incidentId: incident.id, incidentTitle: incident.title, severity: incident.severity, status: incident.status,
    teamId: owner.teamId, teamName: owner.teamName!, ownerSourceId: owner.sourceId,
    serviceIds: incident.services.map((s) => s.id), minServiceTier: Math.min(...incident.services.map((s) => s.tier)),
    asOf: new Date(asOf).toISOString(),
  };
}

export type SubmitResult = { decision: PolicyDecision; ticket: Ticket | null; duplicate: boolean };

/**
 * Warden decides first. Only an allow writes anything. The ticket is a single idempotent MERGE keyed by
 * incident + team, so a retry returns the same ticket instead of creating another.
 */
export async function submitEscalation(
  g: Graph, policy: PolicyAuthority,
  input: { incidentId: string; draftId: string; actorId: string; confirm: boolean; asOf: number },
): Promise<SubmitResult> {
  if (input.confirm !== true) throw new EscalationError("confirmation_required", "Escalation requires explicit confirmation.");
  const draft = await buildDraft(g, input.incidentId, input.asOf);
  if (draft.draftId !== input.draftId) {
    throw new EscalationError("stale_draft", `The draft is out of date (the incident or its owning team changed). Review the new draft for ${draft.teamName} and confirm again.`);
  }
  // Fail closed: if the policy authority itself breaks, that is a deny, never an allow.
  const decision = await policy
    .evaluate({
      actorId: input.actorId,
      facts: { incidentId: draft.incidentId, incidentStatus: draft.status, minServiceTier: draft.minServiceTier, teamId: draft.teamId },
    })
    .catch((e): PolicyDecision => ({
      effect: "deny", reason: `policy unavailable: ${e instanceof Error ? e.message : "unknown error"}`,
      decisionId: "none", policyId: "unavailable", matchedRules: [],
    }));
  if (decision.effect !== "allow") return { decision, ticket: null, duplicate: false };

  const ticketId = `tkt-${createHash("sha256").update(`${draft.incidentId}|${draft.teamId}`).digest("hex").slice(0, 10)}`;
  const now = Date.now();
  const title = `Escalate ${draft.incidentId.toUpperCase()} (${draft.severity}) to ${draft.teamName}`;
  const r = await g.query<{ id: string; createdAt: number; decisionId: string; actor: string }>(
    `MATCH (i:Incident {id:$incidentId}), (tm:Team {id:$teamId})
     MERGE (t:Ticket {id:$ticketId})
     ON CREATE SET t.status = 'open', t.createdAt = $now, t.title = $title, t.actor = $actor, t.decisionId = $decisionId
     MERGE (t)-[:ESCALATES]->(i)
     MERGE (t)-[:ASSIGNED_TO]->(tm)
     RETURN t.id AS id, t.createdAt AS createdAt, t.decisionId AS decisionId, t.actor AS actor`,
    { params: { incidentId: draft.incidentId, teamId: draft.teamId, ticketId, now, title, actor: input.actorId, decisionId: decision.decisionId } },
  );
  const row = r.data?.[0];
  if (!row) throw new EscalationError("incident_not_found", "The incident or team disappeared before the ticket could be created.");
  const created = r.metadata.some((l) => /^Nodes created: [1-9]/.test(l));
  return {
    decision, duplicate: !created,
    ticket: { id: row.id, incidentId: draft.incidentId, teamId: draft.teamId, title, status: "open", createdAt: row.createdAt, actor: row.actor, decisionId: row.decisionId },
  };
}

export async function listTickets(g: Graph, incidentId: string) {
  const r = await g.query<Omit<Ticket, "incidentId"> & { teamId: string }>(
    `MATCH (t:Ticket)-[:ESCALATES]->(:Incident {id:$incidentId}) MATCH (t)-[:ASSIGNED_TO]->(tm:Team)
     RETURN t.id AS id, t.title AS title, t.status AS status, t.createdAt AS createdAt, t.actor AS actor, t.decisionId AS decisionId, tm.id AS teamId
     ORDER BY createdAt`, { params: { incidentId } });
  return (r.data ?? []).map((t) => ({ ...t, incidentId }));
}
