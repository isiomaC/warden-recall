import * as dagre from "@dagrejs/dagre";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Evidence, GraphData } from "../api";
import { edgeKey, TYPES } from "../format";

type NodeData = { type: string; label: string; id: string; state: "plain" | "hit" | "dim" | "focus"; fresh: boolean };
const W = 130;
const H = 44;

function EntityNode({ data }: NodeProps<Node<NodeData>>) {
  return (
    <div className={`node ${data.state === "plain" ? "" : data.state} ${data.fresh ? "fresh" : ""}`} data-type={data.type}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0, pointerEvents: "none" }} />
      <span className="tab">{data.type}</span>
      <div className="node-label" title={data.label}>{data.label}</div>
      <div className="node-id">{data.id}</div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, pointerEvents: "none" }} />
    </div>
  );
}
const nodeTypes = { entity: EntityNode };

/** Teams sit in their own top row so an ownership change never reshuffles the rest of the layout. */
const LAYOUT_SKIP = new Set(["OWNS", "MEMBER_OF", "ASSIGNED_TO"]);

function computeLayout(graph: GraphData, cache: Map<string, { x: number; y: number }>) {
  const needsFull = graph.nodes.some((n) => !cache.has(n.id) && n.type !== "Ticket");
  if (needsFull) {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "TB", nodesep: 12, ranksep: 26, marginx: 16, marginy: 16 });
    g.setDefaultEdgeLabel(() => ({}));
    const core = graph.nodes.filter((n) => n.type !== "Team" && n.type !== "Ticket");
    core.forEach((n) => g.setNode(n.id, { width: W, height: H + 16 }));
    graph.edges.filter((e) => !LAYOUT_SKIP.has(e.type) && g.hasNode(e.from) && g.hasNode(e.to)).forEach((e) => g.setEdge(e.from, e.to));
    dagre.layout(g);
    let minX = Infinity, maxX = -Infinity, minY = Infinity;
    core.forEach((n) => {
      const p = g.node(n.id);
      const pos = { x: p.x - W / 2, y: p.y - H / 2 };
      cache.set(n.id, pos);
      minX = Math.min(minX, pos.x); maxX = Math.max(maxX, pos.x); minY = Math.min(minY, pos.y);
    });
    const teams = graph.nodes.filter((n) => n.type === "Team");
    teams.forEach((t, i) => cache.set(t.id, { x: minX + ((maxX - minX) * (i + 0.5)) / teams.length - W / 2 + W / 2, y: minY - 96 }));
  }
  // tickets hang below the incident they escalate
  graph.nodes.filter((n) => n.type === "Ticket" && !cache.has(n.id)).forEach((t, i) => {
    const e = graph.edges.find((x) => x.from === t.id && x.type === "ESCALATES");
    const anchor = e ? cache.get(e.to) : undefined;
    cache.set(t.id, anchor ? { x: anchor.x, y: anchor.y + 84 + i * 64 } : { x: 0, y: 0 });
  });
}

function FitOnResize({ host }: { host: React.RefObject<HTMLDivElement | null> }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!host.current) return;
    let t: number | undefined;
    const ro = new ResizeObserver(() => { window.clearTimeout(t); t = window.setTimeout(() => fitView({ duration: 0, padding: 0.04 }), 120); });
    ro.observe(host.current);
    return () => { ro.disconnect(); window.clearTimeout(t); };
  }, [fitView, host]);
  return null;
}

type Props = {
  graph: GraphData | null;
  evidence: Evidence | null;
  focusIds: string[];
  freshEdges: Set<string>;
  onOpenSource: (id: string) => void;
};

export function GraphPanel({ graph, evidence, focusIds, freshEdges, onOpenSource }: Props) {
  const cache = useRef(new Map<string, { x: number; y: number }>());
  const host = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [] as Node<NodeData>[], edges: [] as Edge[] };
    computeLayout(graph, cache.current);
    const hasEv = !!evidence && evidence.nodes.length > 0;
    const hitN = new Set(evidence?.nodes.map((n) => n.id));
    const hitE = new Set(evidence?.edges.map(edgeKey));
    const focus = new Set(focusIds);
    const freshNodes = new Set([...freshEdges].flatMap((k) => { const [a, , b] = k.split("|"); return [a, b]; }));
    const nodes: Node<NodeData>[] = graph.nodes.map((n) => {
      const state = focus.size ? (focus.has(n.id) ? "focus" : "dim") : hasEv ? (hitN.has(n.id) ? "hit" : "dim") : "plain";
      return { id: n.id, type: "entity", position: cache.current.get(n.id) ?? { x: 0, y: 0 }, draggable: false, selectable: true, data: { type: n.type, label: n.label, id: n.id, state, fresh: freshNodes.has(n.id) } };
    });
    const edges: Edge[] = graph.edges.map((e) => {
      const k = edgeKey(e);
      const hit = hasEv && hitE.has(k);
      const fresh = freshEdges.has(k);
      const color = hit || fresh ? "var(--accent)" : "var(--ink-3)";
      return {
        id: k, source: e.from, target: e.to, type: "smoothstep", pathOptions: { borderRadius: 8 },
        className: `${hit ? "hit" : hasEv ? "dim" : ""} ${fresh ? "fresh" : ""}`.trim(),
        label: fresh ? e.type : undefined,
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      };
    });
    return { nodes, edges };
  }, [graph, evidence, focusIds, freshEdges]);

  const sel = selected ? graph?.nodes.find((n) => n.id === selected) : null;
  const selEdges = sel ? graph!.edges.filter((e) => e.from === sel.id || e.to === sel.id) : [];

  return (
    <section className="pane" aria-label="Company graph">
      <div className="pane-head">
        <h2>Company graph</h2>
        <span className="hint">{graph ? `${graph.nodes.length} entities, ${graph.edges.length} relationships` : "Loading"}</span>
        <div className="legend" aria-hidden="true">
          {TYPES.map((t) => <span key={t} className="tab" data-type={t}>{t}</span>)}
        </div>
      </div>
      <div className="graph-wrap" ref={host}>
        {!graph ? (
          <div className="skeleton" aria-busy="true"><i style={{ width: "40%" }} /><i style={{ width: "70%" }} /><i style={{ width: "55%" }} /></div>
        ) : (
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.04 }}
              nodesDraggable={false} nodesConnectable={false} minZoom={0.3} maxZoom={1.8}
              onNodeClick={(_, n) => setSelected((cur) => (cur === n.id ? null : n.id))} onPaneClick={() => setSelected(null)}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} size={1} color="var(--seam)" />
              <Controls showInteractive={false} position="top-right" />
              <FitOnResize host={host} />
            </ReactFlow>
          </ReactFlowProvider>
        )}
        {sel && (
          <div className="node-detail" role="region" aria-label={`${sel.label} details`}>
            <div className="row"><span className="tab" data-type={sel.type}>{sel.type}</span><strong>{sel.label}</strong></div>
            <span className="mono hint">{sel.id}</span>
            <ul>{selEdges.map((e) => <li key={edgeKey(e)} className="mono">{e.from === sel.id ? `${e.type} → ${e.to}` : `${e.from} → ${e.type}`}</li>)}</ul>
            <div className="row">
              {sel.type !== "Ticket" && <button className="btn" onClick={() => onOpenSource(sel.id)}>Open source</button>}
              <button className="btn quiet" onClick={() => setSelected(null)}>Close</button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
