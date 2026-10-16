import { useEffect, useRef, useState } from "react";
import type { CompanyBrainAnswer, Intent, PresetId } from "../api";
import { KIND_BADGE } from "../format";

const PRESETS: Array<{ id: PresetId; label: string }> = [
  { id: "investigate-incident", label: "Checkout is down. What is affected, who owns it, who do we escalate to?" },
  { id: "why-queue", label: "Why was the payment queue introduced and what changed?" },
  { id: "who-owns", label: "Who owns the payment queue now?" },
];

export type AskRequest = { question?: string; preset?: PresetId; serviceId?: string; intent?: Intent };

type Props = {
  answer: CompanyBrainAnswer | null;
  loading: boolean;
  changeNote: { title: string; detail: string } | null;
  onAsk: (req: AskRequest) => void;
  onFocus: (ids: string[]) => void;
  onOpenSource: (id: string) => void;
};

export function AskPanel({ answer, loading, changeNote, onAsk, onFocus, onOpenSource }: Props) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "SELECT") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <div className="ask">
        <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) onAsk({ question: text.trim() }); }} role="search">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="q">Ask the company brain</label>
            <input id="q" ref={input} className="input" value={text} onChange={(e) => setText(e.target.value)} maxLength={500}
              placeholder="Who owns billing worker?" autoComplete="off" />
          </div>
          <button className="btn primary" type="submit" disabled={loading || !text.trim()} aria-busy={loading} style={{ alignSelf: "end" }}>Ask</button>
        </form>
        <div className="presets" role="group" aria-label="Example questions">
          {PRESETS.map((p) => (
            <button key={p.id} className="preset" disabled={loading} onClick={() => { setText(""); onAsk({ preset: p.id }); }}>{p.label}</button>
          ))}
        </div>
        <span className="hint">Press <span className="kbd">/</span> to focus the question box.</span>
      </div>

      {loading && !answer && <div className="skeleton" aria-busy="true" aria-label="Loading answer"><i style={{ width: "85%" }} /><i style={{ width: "60%" }} /><i style={{ width: "75%" }} /><i style={{ width: "50%" }} /></div>}

      {!answer && !loading && (
        <div className="empty">
          <strong>Nothing asked yet.</strong>
          <span>Pick the incident question to see affected services, owners and the exact graph paths behind each claim.</span>
        </div>
      )}

      {answer && (
        <div className="answer" aria-live="polite" aria-busy={loading} style={{ opacity: loading ? 0.6 : 1, transition: "opacity 150ms" }}>
          {changeNote && (
            <div className="changed reveal" role="status">
              <strong>{changeNote.title}</strong>
              <span>{changeNote.detail}</span>
            </div>
          )}
          {answer.question && <p className="asked">Asked: <q>{answer.question}</q></p>}
          <p className="headline">{answer.headline}</p>

          {answer.status === "disambiguation" && answer.candidates && (
            <div className="level">
              <div className="level-head"><h3>Which service?</h3><span className="badge warn">Needs a choice</span></div>
              <p className="level-summary">The name matches more than one service. I will not guess between them.</p>
              <div className="presets">
                {answer.candidates.map((c) => (
                  <button key={c.id} className="preset" onClick={() => onAsk({ question: answer.question, serviceId: c.id, intent: answer.intent })}>
                    <strong>{c.name}</strong> <span className="mono">{c.id}</span> <span className="hint">tier {c.tier}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {answer.status === "abstain" && answer.suggestions && (
            <div className="level">
              <div className="level-head"><h3>Try one of these</h3><span className="badge plain">No answer</span></div>
              <div className="presets">
                {answer.suggestions.map((s) => <button key={s} className="preset" onClick={() => onAsk({ question: s })}>{s}</button>)}
              </div>
            </div>
          )}

          {answer.sections.map((s, i) => {
            const b = KIND_BADGE[s.kind];
            return (
              <section key={s.id} className="level reveal" style={{ ["--i" as string]: i }}>
                <div className="level-head"><h3>{s.title}</h3><span className={`badge ${b.cls}`}>{b.label}</span></div>
                <p className="level-summary">{s.summary}</p>
                {s.claims.length > 0 && (
                  <ul className="claims">
                    {s.claims.map((c, j) => (
                      <li key={j} className="claim" tabIndex={0}
                        onMouseEnter={() => onFocus(c.entityIds)} onMouseLeave={() => onFocus([])}
                        onFocus={() => onFocus(c.entityIds)} onBlur={() => onFocus([])}>
                        <p>{c.claim}</p>
                        {c.sourceIds.length > 0 && (
                          <div className="refs" aria-label="Sources">
                            {c.sourceIds.map((id) => <button key={id} className="chip" onClick={() => onOpenSource(id)}>{id}</button>)}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
