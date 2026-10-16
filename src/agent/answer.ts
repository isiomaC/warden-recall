import type { Graph } from "../graph/client.ts";
import { mergeEvidence, type Evidence } from "../graph/paths.ts";
import {
  findRelatedIncidents, findService, getDecisions, getIncident, getOnCall, getOwners, getOwnershipHistory,
  getProjectImpact, getService, getSources, traceImpact, type QueryRecord, type ServiceCandidate, type SourceDoc,
} from "../graph/queries.ts";

export type Claim = { claim: string; entityIds: string[]; sourceIds: string[] };
export type Section = {
  id: string;
  kind: "fact" | "historical" | "recommendation" | "gap";
  title: string;
  summary: string;
  claims: Claim[];
};
export type EscalationProposal = { incidentId: string; teamId: string; teamName: string; serviceIds: string[]; reason: string };

export type CompanyBrainAnswer = {
  status: "ok" | "disambiguation" | "abstain";
  question: string;
  asOf: string;
  headline: string;
  sections: Section[];
  evidence: Evidence;
  queries: QueryRecord[];
  sources: SourceDoc[];
  candidates?: ServiceCandidate[];
  intent?: Intent;
  suggestions?: string[];
  proposal?: EscalationProposal;
};

export type Intent = "investigate" | "impact" | "owner" | "decisions";
export const PRESETS = {
  "investigate-incident": "Checkout is down. What is affected, who owns it, and who should we escalate to?",
  "why-queue": "Why was the payment queue introduced and what changed?",
  "who-owns": "Who owns the payment queue now?",
} as const;
export type PresetId = keyof typeof PRESETS;

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Readable UTC timestamp for answer text: 2026-10-16 12:00 UTC */
const stamp = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

type Collector = { queries: QueryRecord[]; evidence: Evidence[]; sourceIds: Set<string> };
const collector = (): Collector => ({ queries: [], evidence: [], sourceIds: new Set() });

async function finish(g: Graph, base: Omit<CompanyBrainAnswer, "evidence" | "queries" | "sources">, c: Collector): Promise<CompanyBrainAnswer> {
  const ids = [...c.sourceIds];
  const src = ids.length ? await getSources(g, ids) : { query: null, sources: [] as SourceDoc[] };
  if (src.query) c.queries.push(src.query);
  return { ...base, evidence: mergeEvidence(...c.evidence), queries: c.queries, sources: src.sources };
}

const own = (serviceId: string, teamId: string): Evidence => ({
  nodes: [{ id: teamId, type: "Team", label: teamId }, { id: serviceId, type: "Service", label: serviceId }],
  edges: [{ from: teamId, to: serviceId, type: "OWNS" }],
});

/** Owners, on-call and ownership/on-call mismatch for a set of services. */
async function ownershipSections(g: Graph, c: Collector, failedId: string, serviceIds: string[], asOf: number): Promise<Section[]> {
  const { query, owners } = await getOwners(g, serviceIds, asOf);
  c.queries.push(query);
  const claims: Claim[] = [];
  const gaps: Claim[] = [];
  for (const o of owners) {
    if (o.teamId && o.sourceId) {
      c.sourceIds.add(o.sourceId);
      c.evidence.push(own(o.serviceId, o.teamId));
      claims.push({ claim: `${o.teamName} owns ${o.serviceId} (since ${day(o.validFrom!)})`, entityIds: [o.teamId, o.serviceId], sourceIds: [o.sourceId] });
    } else gaps.push({ claim: `Owner of ${o.serviceId} is unknown: no ownership record is effective at ${stamp(asOf)}`, entityIds: [o.serviceId], sourceIds: [] });
  }
  const sections: Section[] = [{
    id: "owners", kind: "fact", title: "Current owners",
    summary: `Ownership as of ${stamp(asOf)}.`, claims,
  }];
  if (gaps.length) sections.push({ id: "owner-gaps", kind: "gap", title: "Evidence gaps", summary: "No source-backed owner could be found for these services.", claims: gaps });

  const oc = await getOnCall(g, [failedId]);
  c.queries.push(oc.query);
  const failedOwner = owners.find((o) => o.serviceId === failedId);
  for (const p of oc.onCall) {
    c.evidence.push({
      nodes: [{ id: p.personId, type: "Person", label: p.personName }, { id: failedId, type: "Service", label: failedId }],
      edges: [{ from: p.personId, to: failedId, type: "ON_CALL_FOR" }],
    });
  }
  if (oc.onCall.length) {
    const mismatch = oc.onCall.filter((p) => failedOwner?.teamId && p.teamId !== failedOwner.teamId);
    sections.push({
      id: "oncall", kind: mismatch.length ? "gap" : "fact", title: "On-call",
      summary: mismatch.length
        ? `On-call does not follow ownership: ${failedId} is owned by ${failedOwner!.teamName}, but ${mismatch.map((p) => `${p.personName} (${p.teamId})`).join(", ")} is still on call. On-call does not transfer automatically; confirm who should respond.`
        : `On-call matches the owning team.`,
      claims: oc.onCall.map((p) => ({ claim: `${p.personName} (${p.teamId}) is on call for ${p.serviceId}`, entityIds: [p.personId, p.serviceId], sourceIds: [p.personId] })),
    });
    oc.onCall.forEach((p) => c.sourceIds.add(p.personId));
  } else {
    sections.push({ id: "oncall", kind: "gap", title: "On-call", summary: `No on-call person is recorded for ${failedId}.`, claims: [] });
  }
  return sections;
}

async function decisionSection(g: Graph, c: Collector, serviceId: string): Promise<Section> {
  const { query, decisions } = await getDecisions(g, serviceId);
  c.queries.push(query);
  const claims: Claim[] = [];
  for (const d of decisions) {
    c.sourceIds.add(d.sourceId);
    c.evidence.push({
      nodes: [{ id: serviceId, type: "Service", label: serviceId }, { id: d.id, type: "ADR", label: d.title }],
      edges: [{ from: serviceId, to: d.id, type: "HAS_DECISION" }, ...d.amends.map((a) => ({ from: d.id, to: a, type: "AMENDS" }))],
    });
    claims.push({
      claim: d.amends.length
        ? `${d.id.toUpperCase()} (${day(d.date)}) amends ${d.amends.map((a) => a.toUpperCase()).join(", ")}: ${d.title}`
        : `${d.id.toUpperCase()} (${day(d.date)}): ${d.title}${d.amendedBy.length ? `; later amended by ${d.amendedBy.map((a) => a.toUpperCase()).join(", ")} (still valid for the queue decision itself)` : ""}`,
      entityIds: [d.id, ...d.amends, ...d.amendedBy], sourceIds: [d.sourceId],
    });
  }
  return {
    id: "decisions", kind: "fact", title: "Decision history",
    summary: decisions.length ? "Architecture decisions for this service. An amendment changes one sub-decision and never invalidates the ADR it amends." : "No architecture decisions are recorded for this service.",
    claims,
  };
}

async function impactSections(g: Graph, c: Collector, failedId: string, asOf: number) {
  const impact = await traceImpact(g, failedId);
  c.queries.push(impact.query);
  const failed = await getService(g, failedId);
  c.queries.push(failed.query);
  const name = failed.service?.name ?? failedId;
  c.evidence.push({ nodes: [{ id: failedId, type: "Service", label: name }], edges: [] });
  impact.impacted.forEach((i) => c.evidence.push(i.evidence));
  const sections: Section[] = [{
    id: "impact", kind: "fact", title: "Affected services",
    summary: impact.impacted.length
      ? `If ${name} fails, ${impact.impacted.length} dependent service${impact.impacted.length === 1 ? " is" : "s are"} affected.`
      : `No service depends on ${name}, so nothing else is affected.`,
    claims: impact.impacted.map((i) => ({
      claim: `${i.name} depends on ${name} (${i.hops} hop${i.hops === 1 ? "" : "s"}: ${i.evidence.nodes.map((n) => n.id).join(" → ")})`,
      entityIds: i.evidence.nodes.map((n) => n.id), sourceIds: [],
    })),
  }];
  const projects = await getProjectImpact(g, failedId);
  c.queries.push(projects.query);
  projects.projects.forEach((p) => { c.evidence.push(p.evidence); c.sourceIds.add(p.projectId); });
  sections.push({
    id: "projects", kind: "fact", title: "Projects at risk",
    summary: projects.projects.length ? "Projects that use the failed service or one of its dependents." : "No projects use the affected services.",
    claims: projects.projects.map((p) => ({
      claim: p.hops === 0 ? `${p.projectName} uses ${p.serviceId} directly` : `${p.projectName} uses ${p.serviceId}, which depends on the failed service (${p.hops} hop${p.hops === 1 ? "" : "s"})`,
      entityIds: [p.projectId, ...p.evidence.nodes.map((n) => n.id)], sourceIds: [p.projectId],
    })),
  });
  return { sections, name, impactedIds: impact.impacted.map((i) => i.id) };
}

export async function investigateIncident(g: Graph, incidentId: string, asOf: number, question: string = PRESETS["investigate-incident"]): Promise<CompanyBrainAnswer> {
  const c = collector();
  const inc = await getIncident(g, incidentId);
  c.queries.push(inc.query);
  const base = { question, asOf: iso(asOf)!, intent: "investigate" as Intent };
  if (!inc.incident) {
    return finish(g, { ...base, status: "abstain", headline: `I can't find incident "${incidentId}" in the company graph.`, sections: [], suggestions: Object.values(PRESETS) }, c);
  }
  const { incident } = inc;
  const failed = incident.services[0];
  c.sourceIds.add(incident.id);
  const impact = await impactSections(g, c, failed.id, asOf);
  const ownership = await ownershipSections(g, c, failed.id, [failed.id, ...impact.impactedIds], asOf);
  const related = await findRelatedIncidents(g, failed.id, incident.id);
  c.queries.push(related.query);
  related.incidents.forEach((i) => c.sourceIds.add(i.id));
  const decisions = await decisionSection(g, c, failed.id);

  const owner = ownership[0].claims.find((cl) => cl.entityIds[1] === failed.id);
  const ownerTeamId = owner?.entityIds[0];
  const ownerName = owner?.claim.split(" owns ")[0];
  const sections: Section[] = [
    ...ownership.filter((s) => s.id !== "oncall" && s.id !== "owner-gaps").map((s) => ({ ...s, title: "Who owns the affected services" })),
    ...impact.sections,
    ...ownership.filter((s) => s.id === "oncall" || s.id === "owner-gaps"),
    { id: "related", kind: "historical", title: "Related incidents",
      summary: related.incidents.length ? "Earlier incidents on the same service." : "No earlier incidents on this service.",
      claims: related.incidents.map((i) => ({ claim: `${i.id.toUpperCase()} (${i.severity}, ${i.status}): ${i.title}`, entityIds: [i.id], sourceIds: [i.id] })) },
    decisions,
  ];
  let proposal: EscalationProposal | undefined;
  if (ownerTeamId && ownerName && incident.status === "open") {
    proposal = {
      incidentId: incident.id, teamId: ownerTeamId, teamName: ownerName, serviceIds: [failed.id],
      reason: `${ownerName} is the current source-backed owner of ${failed.name}.`,
    };
    sections.push({
      id: "recommendation", kind: "recommendation", title: "Recommended next step",
      summary: `Escalate ${incident.id.toUpperCase()} (${incident.severity}) to ${ownerName}, the current owner of ${failed.name}. Warden decides whether the escalation is permitted.`,
      claims: [],
    });
  }
  return finish(g, {
    ...base, status: "ok",
    headline: `${incident.id.toUpperCase()} (${incident.severity}, ${incident.status}): ${failed.name} is failing. ${impact.impactedIds.length} dependent service${impact.impactedIds.length === 1 ? "" : "s"} affected${ownerName ? `; owned by ${ownerName}` : ""}.`,
    sections, proposal,
  }, c);
}

export async function explainImpact(g: Graph, serviceId: string, asOf: number, question: string): Promise<CompanyBrainAnswer> {
  const c = collector();
  const impact = await impactSections(g, c, serviceId, asOf);
  const ownership = await ownershipSections(g, c, serviceId, [serviceId, ...impact.impactedIds], asOf);
  return finish(g, {
    question, asOf: iso(asOf)!, intent: "impact", status: "ok",
    headline: `If ${impact.name} fails, ${impact.impactedIds.length} dependent service${impact.impactedIds.length === 1 ? "" : "s"} are affected.`,
    sections: [...ownership.filter((s) => s.id !== "oncall" && s.id !== "owner-gaps"), ...impact.sections, ...ownership.filter((s) => s.id === "oncall" || s.id === "owner-gaps")],
  }, c);
}

export async function explainOwner(g: Graph, serviceId: string, asOf: number, question: string): Promise<CompanyBrainAnswer> {
  const c = collector();
  const svc = await getService(g, serviceId);
  c.queries.push(svc.query);
  const name = svc.service?.name ?? serviceId;
  const ownership = await ownershipSections(g, c, serviceId, [serviceId], asOf);
  const hist = await getOwnershipHistory(g, serviceId);
  c.queries.push(hist.query);
  hist.history.forEach((h) => c.sourceIds.add(h.sourceId));
  const sections: Section[] = [...ownership];
  if (hist.history.length > 1 || hist.history.some((h) => h.validTo != null)) {
    sections.push({
      id: "history", kind: "historical", title: "Ownership history",
      summary: "Earlier owners are kept as history; only the record effective now is current.",
      claims: hist.history.map((h) => ({
        claim: `${h.teamName} owned ${serviceId} from ${day(h.validFrom)}${h.validTo != null ? ` until ${day(h.validTo)}` : " (current)"}`,
        entityIds: [h.teamId, serviceId], sourceIds: [h.sourceId],
      })),
    });
  }
  const current = ownership[0].claims[0];
  return finish(g, {
    question, asOf: iso(asOf)!, intent: "owner", status: "ok",
    headline: current ? `${current.claim}.` : `The owner of ${name} is unknown: no source-backed ownership record is effective.`,
    sections,
  }, c);
}

export async function explainDecisions(g: Graph, serviceId: string, asOf: number, question: string): Promise<CompanyBrainAnswer> {
  const c = collector();
  const svc = await getService(g, serviceId);
  c.queries.push(svc.query);
  c.evidence.push({ nodes: [{ id: serviceId, type: "Service", label: svc.service?.name ?? serviceId }], edges: [] });
  const section = await decisionSection(g, c, serviceId);
  return finish(g, {
    question, asOf: iso(asOf)!, intent: "decisions", status: section.claims.length ? "ok" : "abstain",
    headline: section.claims.length ? `Decision history for ${svc.service?.name ?? serviceId}.` : `No architecture decisions are recorded for ${svc.service?.name ?? serviceId}.`,
    sections: [section],
  }, c);
}

// ---- free-text routing -------------------------------------------------------------------------

const STOP = new Set("a an the is are was were be been do does did what whats which who whom why how when where of for to in on at by with and or about can you please tell me us it its this that now currently right".split(" "));
const INTENT_WORDS = new Set("own owns owned owner owners ownership responsible oncall on-call why decision decisions adr introduced introduce designed architecture affected affect affects impact impacted down fail fails failing failed outage broke broken depend depends dependents investigate incident change changed".split(" "));

export function detectIntent(text: string): Intent | null {
  const t = text.toLowerCase();
  if (/\b(why|decision|decisions|adr|introduced|designed|architecture|rationale)\b/.test(t)) return "decisions";
  if (/\b(own|owns|owned|owner|owners|ownership|responsible|on-?call)\b/.test(t)) return "owner";
  if (/\b(affect|affected|affects|impact|impacted|down|fail|fails|failing|failed|outage|broke|broken|depend|depends)\b/.test(t)) return "impact";
  return null;
}

/** Resolve a service from free text with the FalkorDB full-text index. Never guesses between near matches. */
export async function resolveService(g: Graph, text: string) {
  const tokens = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter((t) => t && !STOP.has(t) && !INTENT_WORDS.has(t));
  const attempts: string[] = [];
  if (tokens.length) attempts.push(tokens.join(" "));
  for (let i = 0; i < tokens.length - 1; i++) attempts.push(`${tokens[i]} ${tokens[i + 1]}`);
  attempts.push(...tokens);
  const queries: QueryRecord[] = [];
  for (const a of attempts) {
    const r = await findService(g, a);
    if (r.query) queries.push(r.query);
    if (r.candidates.length) return { candidates: r.candidates, ambiguous: r.ambiguous, queries };
  }
  return { candidates: [] as ServiceCandidate[], ambiguous: false, queries };
}

export type AskInput = { question?: string; preset?: PresetId; serviceId?: string; incidentId?: string; intent?: Intent; asOf: number };

export async function ask(g: Graph, input: AskInput): Promise<CompanyBrainAnswer> {
  const { asOf } = input;
  if (input.preset === "investigate-incident") return investigateIncident(g, input.incidentId ?? "inc-102", asOf);
  if (input.preset === "why-queue") return explainDecisions(g, "payment-queue", asOf, PRESETS["why-queue"]);
  if (input.preset === "who-owns") return explainOwner(g, "payment-queue", asOf, PRESETS["who-owns"]);

  const question = (input.question ?? "").trim();
  const abstain = (headline: string, extra: Partial<CompanyBrainAnswer> = {}): CompanyBrainAnswer => ({
    status: "abstain", question, asOf: iso(asOf)!, headline, sections: [], evidence: { nodes: [], edges: [] }, queries: [], sources: [],
    suggestions: Object.values(PRESETS), ...extra,
  });
  if (!question && !input.serviceId) return abstain("Ask a question about a service, its owner, its dependents or its design decisions.");

  const incidentMatch = /\binc-\d+\b/i.exec(question);
  if (incidentMatch) return investigateIncident(g, incidentMatch[0].toLowerCase(), asOf, question);

  const intent = input.intent ?? detectIntent(question);
  if (!intent) return abstain("I can only answer questions about services, owners, dependents and design decisions in the company graph. Try one of these.");

  let serviceId = input.serviceId;
  if (!serviceId) {
    const r = await resolveService(g, question);
    if (!r.candidates.length) return abstain("I couldn't match that to a service in the company graph, so I won't guess.", { queries: r.queries });
    if (r.ambiguous) {
      return {
        status: "disambiguation", question, asOf: iso(asOf)!, intent, candidates: r.candidates,
        headline: `"${question}" matches ${r.candidates.length} services. Which one do you mean?`,
        sections: [], evidence: { nodes: [], edges: [] }, queries: r.queries, sources: [],
      };
    }
    serviceId = r.candidates[0].id;
  }
  if (!(await getService(g, serviceId)).service) return abstain(`I can't find a service with id "${serviceId}".`);
  if (intent === "decisions") return explainDecisions(g, serviceId, asOf, question);
  if (intent === "owner") return explainOwner(g, serviceId, asOf, question);
  return explainImpact(g, serviceId, asOf, question);
}
