import { useEffect, useState } from "react";
import { api, ApiError, type CompanyBrainAnswer, type SourceFile } from "../api";

type Tab = "cypher" | "sources" | "paths";

function splitDoc(content: string) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  if (!m) return { fm: [] as Array<[string, string]>, body: content };
  const fm = m[1].split("\n").map((l) => { const i = l.indexOf(":"); return [l.slice(0, i), l.slice(i + 1).trim()] as [string, string]; });
  return { fm, body: m[2].trim() };
}

type Props = { answer: CompanyBrainAnswer | null; openSource: string | null; sourceNonce: number };

export function EvidencePanel({ answer, openSource, sourceNonce }: Props) {
  const [tab, setTab] = useState<Tab>("cypher");
  const [current, setCurrent] = useState<string | null>(null);
  const [file, setFile] = useState<SourceFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  useEffect(() => {
    if (openSource) { setTab("sources"); setCurrent(openSource); }
  }, [openSource, sourceNonce]);

  useEffect(() => {
    if (!current) { setFile(null); return; }
    let live = true;
    setFileError(null);
    api.source(current).then((f) => live && setFile(f)).catch((e) => {
      if (!live) return;
      setFile(null);
      setFileError(e instanceof ApiError && e.status === 404 ? `No source document "${current}" exists in the graph.` : e.message);
    });
    return () => { live = false; };
  }, [current]);

  useEffect(() => {
    if (answer && !current && answer.sources.length) setCurrent(answer.sources[0].id);
  }, [answer, current]);

  const doc = file ? splitDoc(file.content) : null;
  const queries = answer?.queries ?? [];
  const sources = answer?.sources ?? [];
  const edges = answer?.evidence.edges ?? [];

  return (
    <section className="pane" aria-label="Evidence inspector">
      <div className="tabs" role="tablist" aria-label="Evidence">
        {([["cypher", `Cypher (${queries.length})`], ["sources", `Sources (${sources.length})`], ["paths", `Paths (${edges.length})`]] as const).map(([id, label]) => (
          <button key={id} role="tab" className="tabbtn" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      <div className="pane-body" role="tabpanel">
        {!answer && <div className="empty"><strong>No evidence yet.</strong><span>Every answer lists the parameterized Cypher that produced it, the source documents it cites, and the graph paths it walked.</span></div>}

        {answer && tab === "cypher" && (queries.length === 0
          ? <div className="empty"><strong>No graph query ran.</strong><span>This answer abstained before touching the graph.</span></div>
          : queries.map((q, i) => (
            <div key={i} className="q">
              <div className="q-head"><span>{q.name}</span></div>
              <pre className="cypher">{q.cypher}</pre>
              {Object.keys(q.params).length > 0 && (
                <div className="params" aria-label="Parameters">
                  {Object.entries(q.params).map(([k, v]) => <span key={k} className="chip">${k} = {typeof v === "string" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.length} ids]` : String(v)}</span>)}
                </div>
              )}
            </div>
          )))}

        {answer && tab === "sources" && (sources.length === 0
          ? <div className="empty"><strong>No sources cited.</strong><span>Nothing in this answer is backed by a document, so none is claimed.</span></div>
          : (
            <div className="src-grid">
              <div className="src-list" role="list">
                {sources.map((s) => (
                  <button key={s.id} className="src-item" aria-current={current === s.id} onClick={() => setCurrent(s.id)}>
                    <span className="mono">{s.id}</span><span>{s.title}</span>
                  </button>
                ))}
              </div>
              <div className="doc">
                {fileError && <p className="hint" role="alert">{fileError}</p>}
                {file && doc && (
                  <>
                    <div className="mono hint">{file.path}</div>
                    <dl className="fm">{doc.fm.map(([k, v]) => <><dt key={`k${k}`}>{k}</dt><dd key={`v${k}`}>{v}</dd></>)}</dl>
                    <div className="doc-body">{doc.body}</div>
                  </>
                )}
                {!file && !fileError && current && <p className="hint">Loading source</p>}
              </div>
            </div>
          ))}

        {answer && tab === "paths" && (edges.length === 0
          ? <div className="empty"><strong>No graph paths.</strong><span>This answer did not traverse any relationships.</span></div>
          : (
            <ul className="paths" aria-label="Graph paths as text">
              {edges.map((e, i) => (
                <li key={i}><span>{e.from}</span><span className="arrow">{e.type}</span><span>{e.to}</span></li>
              ))}
            </ul>
          ))}
      </div>
    </section>
  );
}
