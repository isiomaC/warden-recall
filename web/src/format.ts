export const TYPE_LABEL: Record<string, string> = {
  Service: "Service", Team: "Team", Person: "Person", Project: "Project", ADR: "ADR", Incident: "Incident", Ticket: "Ticket",
};
export const TYPES = Object.keys(TYPE_LABEL);

const pad = (n: number) => String(n).padStart(2, "0");
/** UTC, fixed format, so recordings are unambiguous: 2026-10-16 12:00 */
export function fmt(ms: number | string | null | undefined): string {
  if (ms == null) return "";
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export const fmtDay = (ms: number) => fmt(ms).slice(0, 10);

export const KIND_BADGE: Record<string, { label: string; cls: string }> = {
  fact: { label: "Source-backed", cls: "ok" },
  historical: { label: "Historical", cls: "plain" },
  gap: { label: "Evidence gap", cls: "warn" },
  recommendation: { label: "Recommendation", cls: "info" },
};

export const edgeKey = (e: { from: string; to: string; type: string }) => `${e.from}|${e.type}|${e.to}`;
