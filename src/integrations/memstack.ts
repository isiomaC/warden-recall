import { DiskStorageAdapter, HarnessMemory } from "@memstack/core";

/**
 * Cross-session investigation memory, backed by the real @memstack/core HarnessMemory.
 * Memories hold a summary plus references (graph node ids, document ids, who owned the service then).
 * They are historical context and are always revalidated against the graph before being shown.
 */
const PROJECT = "warden-recall";
const NAMESPACE = `project:${PROJECT}`;
const REFS_MARK = "\n\n[refs] ";

export type InvestigationRefs = {
  incidentId: string;
  serviceId: string;
  graphNodeIds: string[];
  documentIds: string[];
  ownerTeamId: string | null;
  ownerTeamName: string | null;
  ownerSourceId: string | null;
  asOf: string;
};
export type RecalledInvestigation = { id: string; savedAt: string; sessionId: string | null; summary: string; refs: InvestigationRefs };

export interface InvestigationMemory {
  save(input: { sessionId: string; summary: string; refs: InvestigationRefs }): Promise<{ id: string }>;
  recall(incidentId: string): Promise<RecalledInvestigation[]>;
}

export function createMemStackMemory(storageDir = process.env.MEMSTACK_DIR ?? ".data/memstack"): InvestigationMemory {
  const memory = new HarnessMemory({ storage: new DiskStorageAdapter({ storageDir }), secretPolicy: "reject" });
  return {
    async save({ sessionId, summary, refs }) {
      const m = await memory.remember({
        namespace: NAMESPACE,
        content: `${summary}${REFS_MARK}${JSON.stringify(refs)}`,
        kind: "summary",
        importance: 0.7,
        tags: ["investigation", `incident:${refs.incidentId}`],
        source: { harness: "warden-recall", project: PROJECT, sessionId },
      });
      return { id: m.id };
    },
    async recall(incidentId) {
      const tag = `incident:${incidentId}`;
      const { hits } = await memory.recall({ namespaces: [NAMESPACE], query: `investigation ${incidentId}`, kinds: ["summary"], limit: 10 });
      const out: RecalledInvestigation[] = [];
      for (const { memory: m } of hits) {
        if (!m.tags.includes(tag)) continue; // recall falls back to unrelated recents when nothing matches; never surface those
        const i = m.content.indexOf(REFS_MARK);
        if (i < 0) continue;
        try {
          const refs = JSON.parse(m.content.slice(i + REFS_MARK.length)) as InvestigationRefs;
          const source = (m.metadata?.source ?? {}) as { sessionId?: string };
          out.push({ id: m.id, savedAt: new Date(m.createdAt).toISOString(), sessionId: source.sessionId ?? null, summary: m.content.slice(0, i), refs });
        } catch { /* skip malformed memory */ }
      }
      return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    },
  };
}
