import { useEffect, useState } from "react";
import type { AuditEntry, EscalationDraft, IngestResult, OwnershipInterval, PreviewDoc, RevalidatedMemory, SubmitResult, Ticket } from "../api";
import { api, ApiError } from "../api";
import { fmt } from "../format";
import { CustodyStrip } from "./CustodyStrip";

export const INCIDENT = "inc-102";
export const CUSTODY_SERVICE = "payment-queue";

type Props = {
  asOf: number;
  custody: OwnershipInterval[];
  sessionId: string;
  memories: RevalidatedMemory[];
  memoryError: string | null;
  hasAnswer: boolean;
  actor: "sre" | "intern";
  onActor: (a: "sre" | "intern") => void;
  preview: PreviewDoc | null;
  receipt: { result: IngestResult; docId: string } | null;
  onIngest: () => Promise<void>;
  onOpenSource: (id: string) => void;
  onMemorySaved: () => Promise<void>;
  onGraphChanged: () => Promise<void>;
  onNewSession: () => void;
};

function useBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof ApiError || e instanceof Error ? e.message : "Something went wrong."); } finally { setBusy(false); }
  };
  return { busy, error, run, setError };
}

export function ActionsPanel(p: Props) {
  const ingest = useBusy();
  const esc = useBusy();
  const mem = useBusy();
  const [draft, setDraft] = useState<EscalationDraft | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [audit, setAudit] = useState<{ entries: AuditEntry[]; valid: boolean } | null>(null);

  const refreshAudit = async () => { const a = await api.audit(); setAudit({ entries: a.entries, valid: a.verification.valid }); };
  useEffect(() => { api.tickets(INCIDENT).then((t) => setTickets(t.tickets)).catch(() => {}); refreshAudit().catch(() => {}); }, []);

  // a draft is only valid for the owner it was built for; drop it when the graph changes under it
  useEffect(() => { setDraft(null); setResult(null); }, [p.receipt?.docId]);

  const propose = () => esc.run(async () => {
    setResult(null);
    const r = await api.propose(INCIDENT);
    setDraft(r.draft); setTickets(r.tickets);
  });
  const confirm = () => esc.run(async () => {
    if (!draft) return;
    try {
      const r = await api.submit({ incidentId: INCIDENT, draftId: draft.draftId, actor: p.actor });
      setResult(r); setTickets(r.tickets);
      if (r.ticket) await p.onGraphChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === "stale_draft") setDraft(null);
      throw e;
    } finally { await refreshAudit().catch(() => {}); }
  });
  const saveMemory = () => mem.run(async () => { await api.saveMemory(INCIDENT, p.sessionId); await p.onMemorySaved(); });

  return (
    <>
      <section className="sect" aria-labelledby="h-fresh">
        <h2 id="h-fresh">Ownership of Payment Queue
          {p.preview?.applied ? <span className="badge ok">update applied</span> : <span className="badge warn">update pending</span>}
        </h2>
        <CustodyStrip serviceId={CUSTODY_SERVICE} history={p.custody} asOf={p.asOf} />
        {p.preview && (
          <>
            <div className="row">
              <button className="chip" onClick={() => p.onOpenSource(p.preview!.id)} disabled={!p.preview.applied} title={p.preview.applied ? "Open the ingested document" : p.preview.path}>{p.preview.id}</button>
              {p.preview.applied && <span className="hint">ingested</span>}
            </div>
            {!p.preview.applied && (
              <>
                <pre className="docprev">{p.preview.content.replace(/^---\n[\s\S]*?\n---\n/, "").trim()}</pre>
                <button className="btn primary" disabled={ingest.busy} aria-busy={ingest.busy} onClick={() => ingest.run(p.onIngest)}>{ingest.busy ? "Ingesting" : "Ingest this document"}</button>
              </>
            )}
          </>
        )}
        {ingest.error && <p className="hint" role="alert" style={{ color: "var(--deny)" }}>{ingest.error}</p>}
        {p.receipt && (
          <p className="receipt reveal" role="status">
            Ingested {p.receipt.result.documentsIngested} document, closed {p.receipt.result.ownershipClosed} ownership interval, created {p.receipt.result.relationshipsCreated} relationship.
          </p>
        )}
      </section>

      <section className="sect" aria-labelledby="h-esc">
        <h2 id="h-esc">Escalate INC-102</h2>
        <div className="field">
          <label htmlFor="actor">Acting as</label>
          <select id="actor" className="select" value={p.actor} onChange={(e) => { p.onActor(e.target.value as "sre" | "intern"); setResult(null); }}>
            <option value="sre">sre (on-call engineer)</option>
            <option value="intern">intern</option>
          </select>
          <span className="hint">Warden decides on the server. The browser cannot assert an authorization result.</span>
        </div>
        {!draft ? (
          <button className="btn" onClick={propose} disabled={esc.busy} aria-busy={esc.busy}>Propose escalation</button>
        ) : (
          <div className="decision" style={{ background: "var(--panel-2)" }}>
            <span><strong>Draft:</strong> escalate {draft.incidentId.toUpperCase()} ({draft.severity}, {draft.status}) to <strong>{draft.teamName}</strong></span>
            <span className="hint">Owner from <button className="chip" onClick={() => p.onOpenSource(draft.ownerSourceId)}>{draft.ownerSourceId}</button> as of {fmt(draft.asOf)} UTC</span>
            <button className="btn primary" onClick={confirm} disabled={esc.busy} aria-busy={esc.busy}>Confirm as {p.actor}</button>
          </div>
        )}
        {esc.error && <p className="hint" role="alert" style={{ color: "var(--deny)" }}>{esc.error}</p>}
        {result && (
          <div className={`decision ${result.decision.effect} reveal`} role="status">
            <span className={`badge ${result.decision.effect === "allow" ? "ok" : "deny"}`}>Warden: {result.decision.effect === "allow" ? "Allowed" : "Denied"}</span>
            <span>{result.decision.reason}</span>
            <span className="hint mono">decision {result.decision.decisionId} / {result.decision.policyId}</span>
            {result.ticket && <span>{result.duplicate ? "Existing ticket returned" : "Ticket created"}: <strong className="mono">{result.ticket.id}</strong>, assigned to {result.ticket.teamId}</span>}
            {!result.ticket && <span className="hint">No ticket was created.</span>}
          </div>
        )}
        {tickets.length > 0 && (
          <ul className="list" aria-label="Tickets">
            {tickets.map((t) => <li key={t.id}><span><strong className="mono">{t.id}</strong> <span className="badge info">{t.status}</span></span><span className="hint">{t.title}</span></li>)}
          </ul>
        )}
        {audit && (
          <p className="hint">Warden audit chain: {audit.entries.length} decision{audit.entries.length === 1 ? "" : "s"}, {audit.valid ? "hash chain valid" : "HASH CHAIN BROKEN"}.</p>
        )}
      </section>

      <section className="sect" aria-labelledby="h-mem">
        <h2 id="h-mem">Memory (MemStack)</h2>
        <div className="row">
          <button className="btn" onClick={saveMemory} disabled={mem.busy || !p.hasAnswer} aria-busy={mem.busy} title={p.hasAnswer ? "" : "Ask the incident question first"}>Save investigation</button>
          <button className="btn quiet" onClick={p.onNewSession}>New session</button>
        </div>
        <span className="hint">Session <span className="mono">{p.sessionId}</span></span>
        {mem.error && <p className="hint" role="alert" style={{ color: "var(--deny)" }}>{mem.error}</p>}
        {p.memoryError && <p className="hint" role="alert" style={{ color: "var(--warn)" }}>{p.memoryError}</p>}
        {p.memories.length === 0 && !p.memoryError && <p className="hint">Nothing remembered for INC-102 yet. Saved investigations appear here in later sessions, labelled as memory and checked against the graph.</p>}
        {p.memories.slice(0, 2).map((m) => (
          <div key={m.id} className={`mem ${m.stale ? "stale" : ""}`}>
            <div className="row">
              <span className="badge plain">Remembered</span>
              <span className={`badge ${m.stale ? "warn" : "ok"}`}>{m.stale ? "Out of date" : "Matches graph"}</span>
              <span className="hint mono" style={{ marginLeft: "auto" }}>{fmt(m.savedAt)}</span>
            </div>
            <p>{m.summary}</p>
            {m.changes.map((c, i) => <p key={i} style={{ color: "var(--warn)" }}>{c}</p>)}
            <span className="hint mono">session {m.sessionId ?? "unknown"}</span>
          </div>
        ))}
        {p.memories.length > 2 && <p className="hint">{p.memories.length - 2} older remembered investigation{p.memories.length - 2 === 1 ? "" : "s" } not shown.</p>}
      </section>
    </>
  );
}
