import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type CompanyBrainAnswer, type GraphData, type Health, type IngestResult, type OwnershipInterval, type PreviewDoc, type RevalidatedMemory } from "./api";
import { ActionsPanel, CUSTODY_SERVICE, INCIDENT } from "./components/ActionsPanel";
import { AskPanel, type AskRequest } from "./components/AskPanel";
import { EvidencePanel } from "./components/EvidencePanel";
import { GraphPanel } from "./components/GraphPanel";
import { Header } from "./components/Header";
import { edgeKey } from "./format";

const newSessionId = () => `sess-${Math.random().toString(36).slice(2, 8)}`;
type Panel = "answer" | "graph" | "actions";

/** What changed between two real answers, derived only from their structured fields. */
function describeChange(before: CompanyBrainAnswer, after: CompanyBrainAnswer, docId: string, custody: OwnershipInterval[]): { title: string; detail: string } | null {
  const via = custody.length > 1 ? `${custody[custody.length - 1].sourceId} superseded ${custody[custody.length - 2].sourceId}` : docId;
  if (before.proposal && after.proposal && before.proposal.teamId !== after.proposal.teamId) {
    return { title: `Answer changed: escalation target moved from ${before.proposal.teamName} to ${after.proposal.teamName}`, detail: `Because ${via}. The earlier owner stays in the custody history.` };
  }
  if (before.headline !== after.headline) return { title: "Answer changed after ingesting the document", detail: `Now: ${after.headline} Previously: ${before.headline}` };
  return null;
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [down, setDown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [freshEdges, setFreshEdges] = useState<Set<string>>(new Set());
  const [answer, setAnswer] = useState<CompanyBrainAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const [changeNote, setChangeNote] = useState<{ title: string; detail: string } | null>(null);
  const [focusIds, setFocusIds] = useState<string[]>([]);
  const [openSource, setOpenSource] = useState<string | null>(null);
  const [sourceNonce, setSourceNonce] = useState(0);
  const [custody, setCustody] = useState<OwnershipInterval[]>([]);
  const [preview, setPreview] = useState<PreviewDoc | null>(null);
  const [receipt, setReceipt] = useState<{ result: IngestResult; docId: string } | null>(null);
  const [memories, setMemories] = useState<RevalidatedMemory[]>([]);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState(newSessionId);
  const [actor, setActor] = useState<"sre" | "intern">("sre");
  const [panel, setPanel] = useState<Panel>("answer");
  const lastReq = useRef<AskRequest | null>(null);
  const graphRef = useRef<GraphData | null>(null);

  const fail = useCallback((e: unknown) => {
    if (e instanceof ApiError && (e.code === "graph_unavailable" || e.code === "network")) { setDown(true); setError(null); }
    else setError(e instanceof Error ? e.message : "Something went wrong.");
  }, []);

  const refreshGraph = useCallback(async (markFresh = false) => {
    const next = await api.graph();
    if (markFresh && graphRef.current) {
      const before = new Set(graphRef.current.edges.map(edgeKey));
      const fresh = new Set(next.edges.map(edgeKey).filter((k) => !before.has(k)));
      setFreshEdges(fresh);
      window.setTimeout(() => setFreshEdges(new Set()), 4000);
    }
    graphRef.current = next;
    setGraph(next);
  }, []);
  const refreshHealth = useCallback(async () => { setHealth(await api.health()); setDown(false); }, []);
  const refreshCustody = useCallback(async () => setCustody((await api.custody(CUSTODY_SERVICE)).history), []);
  const refreshPreview = useCallback(async () => setPreview((await api.updatePreview()).updates[0] ?? null), []);
  const refreshMemory = useCallback(async () => {
    try { setMemories((await api.memory(INCIDENT)).memories); setMemoryError(null); }
    catch (e) {
      setMemories([]);
      if (e instanceof ApiError && e.code === "memory_unavailable") setMemoryError(e.message); else throw e;
    }
  }, []);

  const refreshAll = useCallback(async () => {
    try { await Promise.all([refreshHealth(), refreshGraph(), refreshCustody(), refreshPreview(), refreshMemory()]); setError(null); }
    catch (e) { fail(e); }
  }, [refreshHealth, refreshGraph, refreshCustody, refreshPreview, refreshMemory, fail]);

  useEffect(() => { void refreshAll(); }, [refreshAll]);

  const ask = useCallback(async (req: AskRequest, compare?: { before: CompanyBrainAnswer; docId: string }) => {
    lastReq.current = req;
    setLoading(true); setChangeNote(null); setFocusIds([]);
    try {
      const a = await api.ask(req);
      setAnswer(a); setError(null); setDown(false);
      if (compare) setChangeNote(describeChange(compare.before, a, compare.docId, (await api.custody(CUSTODY_SERVICE)).history));
    } catch (e) { fail(e); } finally { setLoading(false); }
  }, [fail]);

  const ingest = useCallback(async () => {
    const before = answer;
    const { result } = await api.ingestUpdate();
    const docId = preview?.id ?? "the ownership document";
    setReceipt({ result, docId });
    await Promise.all([refreshGraph(true), refreshCustody(), refreshPreview(), refreshHealth(), refreshMemory()]);
    if (before && lastReq.current) await ask(lastReq.current, { before, docId });
  }, [answer, preview, refreshGraph, refreshCustody, refreshPreview, refreshHealth, refreshMemory, ask]);

  const reset = useCallback(async () => {
    try {
      await api.reset();
      lastReq.current = null; graphRef.current = null;
      setAnswer(null); setChangeNote(null); setReceipt(null); setFreshEdges(new Set()); setSessionId(newSessionId());
      await refreshAll();
    } catch (e) { fail(e); }
  }, [refreshAll, fail]);

  const newSession = useCallback(() => {
    setSessionId(newSessionId()); lastReq.current = null;
    setAnswer(null); setChangeNote(null); setFocusIds([]);
    void refreshMemory().catch(fail);
  }, [refreshMemory, fail]);

  const showSource = useCallback((id: string) => { setOpenSource(id); setSourceNonce((n) => n + 1); setPanel("graph"); }, []);
  const asOf = health ? Date.parse(health.asOf) : Date.now();

  return (
    <div className="app">
      <Header health={health} down={down} onReset={reset} />
      {down && (
        <div className="banner error" role="alert">
          <span>FalkorDB is unreachable, so nothing can be answered or escalated. No cached or canned answer is shown.</span>
          <button className="btn" onClick={() => void refreshAll()}>Retry</button>
        </div>
      )}
      {error && !down && <div className="banner error" role="alert"><span>{error}</span><button className="btn" onClick={() => setError(null)}>Dismiss</button></div>}

      <main className="main">
        <div className="mobile-tabs" role="tablist" aria-label="Panels">
          {([["answer", "Answer"], ["graph", "Graph and evidence"], ["actions", "Actions"]] as const).map(([id, label]) => (
            <button key={id} role="tab" className="tabbtn" aria-selected={panel === id} onClick={() => setPanel(id)}>{label}</button>
          ))}
        </div>
        <div className="col" data-panel="answer" data-active={panel === "answer"}>
          <AskPanel answer={answer} loading={loading} changeNote={changeNote} onAsk={(r) => void ask(r)} onFocus={setFocusIds} onOpenSource={showSource} />
        </div>
        <div className="center" data-panel="graph" data-active={panel === "graph"}>
          <GraphPanel graph={graph} evidence={answer?.evidence ?? null} focusIds={focusIds} freshEdges={freshEdges} onOpenSource={showSource} />
          <EvidencePanel answer={answer} openSource={openSource} sourceNonce={sourceNonce} />
        </div>
        <div className="col" data-panel="actions" data-active={panel === "actions"}>
          <ActionsPanel
            asOf={asOf} custody={custody} sessionId={sessionId} memories={memories} memoryError={memoryError} hasAnswer={!!answer?.proposal}
            actor={actor} onActor={setActor} preview={preview} receipt={receipt} onIngest={ingest} onOpenSource={showSource}
            onMemorySaved={refreshMemory} onGraphChanged={() => refreshGraph()} onNewSession={newSession}
          />
        </div>
      </main>
    </div>
  );
}
