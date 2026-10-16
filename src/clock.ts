/** Effective "now" for ownership queries. DEMO_AS_OF (ISO UTC) makes replays deterministic. */
export function effectiveAsOf(override?: string | number): number {
  if (typeof override === "number") return override;
  const iso = override ?? process.env.DEMO_AS_OF;
  if (iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) throw new Error(`invalid as-of time: ${iso}`);
    return t;
  }
  return Date.now();
}
