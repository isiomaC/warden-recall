import { useState } from "react";
import type { Health } from "../api";
import { fmt } from "../format";

type Props = { health: Health | null; down: boolean; onReset: () => Promise<void> };

export function Header({ health, down, onReset }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <header className="header">
      <div className="brand">Warden Recall<small>Company brain for Northstar Commerce (synthetic data)</small></div>
      <div className="header-meta">
        <span className={`status ${down ? "down" : health ? "up" : ""}`} role="status">
          <i aria-hidden="true" />{down ? "FalkorDB unreachable" : health ? `FalkorDB connected, ${health.nodes} nodes` : "Connecting"}
        </span>
        {health && <span>As of <span className="mono">{fmt(health.asOf)} UTC</span>{health.demoClock ? " (demo clock)" : ""}</span>}
        {confirming ? (
          <span className="row">
            <span>Wipe and reseed the demo?</span>
            <button className="hbtn" disabled={busy} onClick={async () => { setBusy(true); try { await onReset(); } finally { setBusy(false); setConfirming(false); } }}>Yes, reset</button>
            <button className="hbtn" onClick={() => setConfirming(false)}>Cancel</button>
          </span>
        ) : (
          <button className="hbtn" onClick={() => setConfirming(true)}>Reset demo</button>
        )}
      </div>
    </header>
  );
}
