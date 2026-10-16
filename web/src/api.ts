import type { CompanyBrainAnswer, Intent, PresetId } from "../../src/agent/answer.ts";
import type { EscalationDraft, Ticket } from "../../src/actions/escalation.ts";
import type { RevalidatedMemory } from "../../src/actions/memory.ts";
import type { Evidence } from "../../src/graph/paths.ts";
import type { OwnershipInterval, QueryRecord } from "../../src/graph/queries.ts";
import type { IngestResult } from "../../src/ingestion/ingest.ts";
import type { PolicyDecision } from "../../src/integrations/warden.ts";

export type { CompanyBrainAnswer, EscalationDraft, Evidence, Intent, IngestResult, OwnershipInterval, PolicyDecision, PresetId, QueryRecord, RevalidatedMemory, Ticket };

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly body?: any) { super(message); }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, "network", "The API server is not reachable.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? "error", body.message ?? `Request failed (${res.status}).`, body);
  return body as T;
}
const post = <T,>(path: string, body?: unknown) =>
  call<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

export type Health = { status: string; graph: string; nodes: number; asOf: string; demoClock: boolean };
export type GraphData = { asOf: string; nodes: Array<{ id: string; type: string; label: string }>; edges: Array<{ from: string; to: string; type: string }> };
export type PreviewDoc = { id: string; path: string; title: string; applied: boolean; content: string };
export type SourceFile = { id: string; title: string; path: string; content: string };
export type AuditEntry = { hash: string; event: { eventId: string; occurredAt: string; actor?: string; resourceId?: string; payload: { effect: string; reason: string } } };
export type SubmitResult = { decision: PolicyDecision; ticket: Ticket | null; duplicate: boolean; tickets: Ticket[] };

export const api = {
  health: () => call<Health>("/api/health"),
  graph: () => call<GraphData>("/api/graph"),
  ask: (body: { question?: string; preset?: PresetId; serviceId?: string; intent?: Intent }) => post<CompanyBrainAnswer>("/api/ask", body),
  custody: (serviceId: string) => call<{ history: OwnershipInterval[] }>(`/api/custody/${encodeURIComponent(serviceId)}`),
  source: (id: string) => call<SourceFile>(`/api/source/${encodeURIComponent(id)}`),
  updatePreview: () => call<{ updates: PreviewDoc[] }>("/api/update-preview"),
  ingestUpdate: () => post<{ result: IngestResult; ingestedAt: string }>("/api/ingest-update"),
  reset: () => post<{ result: IngestResult }>("/api/reset"),
  propose: (incidentId: string) => post<{ draft: EscalationDraft; tickets: Ticket[] }>("/api/escalation/propose", { incidentId }),
  submit: (body: { incidentId: string; draftId: string; actor: string }) =>
    post<SubmitResult>("/api/escalation/submit", { ...body, confirm: true }).catch((e) => {
      // a Warden deny is a normal 403 with a decision body, not an error
      if (e instanceof ApiError && e.status === 403 && e.body?.decision) return e.body as SubmitResult;
      throw e;
    }),
  tickets: (incidentId: string) => call<{ tickets: Ticket[] }>(`/api/tickets?incidentId=${incidentId}`),
  audit: () => call<{ entries: AuditEntry[]; verification: { valid: boolean; entries?: number } }>("/api/audit"),
  saveMemory: (incidentId: string, sessionId: string) => post<{ saved: { id: string; summary: string } }>("/api/memory/save", { incidentId, sessionId }),
  memory: (incidentId: string) => call<{ memories: RevalidatedMemory[] }>(`/api/memory?incidentId=${incidentId}`),
};
