export type RawNode = { id: number; labels: string[]; properties: Record<string, any> };
export type RawEdge = { id: number; sourceId: number; destinationId: number; relationshipType: string; properties: Record<string, any> };

export type EvidenceNode = { id: string; type: string; label: string };
export type EvidenceEdge = { from: string; to: string; type: string };
export type Evidence = { nodes: EvidenceNode[]; edges: EvidenceEdge[] };

export const evidenceNode = (n: RawNode): EvidenceNode => ({
  id: n.properties.id,
  type: n.labels[0],
  label: n.properties.name ?? n.properties.title ?? n.properties.id,
});

/** Maps FalkorDB's internal ids to domain ids so evidence is stable and human-readable. */
export function toEvidence(nodes: RawNode[], edges: RawEdge[]): Evidence {
  const domainId = new Map(nodes.map((n) => [n.id, n.properties.id as string]));
  return {
    nodes: nodes.map(evidenceNode),
    edges: edges.map((e) => ({ from: domainId.get(e.sourceId)!, to: domainId.get(e.destinationId)!, type: e.relationshipType })),
  };
}

export function mergeEvidence(...parts: Evidence[]): Evidence {
  const nodes = new Map<string, EvidenceNode>();
  const edges = new Map<string, EvidenceEdge>();
  for (const p of parts) {
    p.nodes.forEach((n) => nodes.set(n.id, n));
    p.edges.forEach((e) => edges.set(`${e.from}|${e.type}|${e.to}`, e));
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
