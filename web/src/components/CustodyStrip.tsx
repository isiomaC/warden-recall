import { useEffect, useRef, useState } from "react";
import type { OwnershipInterval } from "../api";
import { fmt, fmtDay } from "../format";

/** Ownership intervals as a chain of custody. Segment width is proportional to time held. */
export function CustodyStrip({ serviceId, history, asOf }: { serviceId: string; history: OwnershipInterval[]; asOf: number }) {
  const seen = useRef(new Set<string>());
  const [entering, setEntering] = useState<string | null>(null);

  useEffect(() => {
    const fresh = history.find((h) => !seen.current.has(h.sourceId));
    history.forEach((h) => seen.current.add(h.sourceId));
    if (fresh && seen.current.size > 1 && history.length > 1) {
      setEntering(fresh.sourceId);
      const t = window.setTimeout(() => setEntering(null), 900);
      return () => window.clearTimeout(t);
    }
  }, [history]);

  if (history.length === 0) {
    return <p className="hint">No ownership record exists for {serviceId}. The owner is unknown.</p>;
  }
  const start = history[0].validFrom;
  const end = Math.max(asOf, history[history.length - 1].validFrom + 3_600_000);
  const span = end - start;

  return (
    <div className="custody" role="group" aria-label={`Custody of ${serviceId}`}>
      <div className="custody-track">
        {history.map((h) => {
          const to = h.validTo ?? end;
          const current = h.validTo == null;
          const w = Math.max(((to - h.validFrom) / span) * 100, current ? 45 : 30);
          return (
            <div key={h.sourceId} className={`seg ${current ? "" : "past"} ${entering === h.sourceId ? "enter" : ""}`} style={{ ["--w" as string]: w }}>
              <span className="seg-team">{h.teamName}</span>
              <span className="seg-meta">{current ? "current" : "transferred"}</span>
              <span className="seg-meta seg-src" title={h.sourceId}>{h.sourceId}</span>
            </div>
          );
        })}
      </div>
      <div className="custody-axis"><span>{fmtDay(start)}</span>{history.length > 1 && <span>transfer {fmt(history[1].validFrom)} UTC</span>}</div>
    </div>
  );
}
