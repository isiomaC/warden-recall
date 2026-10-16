import { AuditChain, createWarden, definePolicy, verifyAuditChain, type AuditEntry } from "@stlw/warden";

/**
 * Escalation authorization, enforced by the real @stlw/warden engine.
 * Unmatched requests, unknown conditions, evaluation errors and unknown actors all deny; DENY wins over ALLOW.
 */
export const ACTORS = {
  sre: { id: "sre", role: "sre" },
  intern: { id: "intern", role: "intern" },
} as const;
export type ActorId = keyof typeof ACTORS;
export const isActorId = (v: unknown): v is ActorId => typeof v === "string" && Object.hasOwn(ACTORS, v);

/** Facts about the resource, always derived from the graph on the server, never supplied by the client. */
export type EscalationFacts = { incidentId: string; incidentStatus: string; minServiceTier: number; teamId: string };

export type PolicyDecision = {
  effect: "allow" | "deny";
  reason: string;
  decisionId: string;
  policyId: string;
  matchedRules: string[];
};

export interface PolicyAuthority {
  evaluate(input: { actorId: string; facts: EscalationFacts }): Promise<PolicyDecision>;
  audit(): { entries: AuditEntry[]; verification: ReturnType<typeof verifyAuditChain> };
}

const policy = definePolicy({
  id: "escalation-policy",
  version: 1,
  rules: [
    { id: "deny-intern", effect: "DENY", conditions: [{ name: "actor.role", value: "intern" }] },
    {
      id: "allow-sre-open-tier1",
      effect: "ALLOW",
      conditions: [{ name: "actor.role", value: "sre" }, { name: "incident.open" }, { name: "service.tierAtMost", value: 1 }],
    },
  ],
});

const REASONS: Record<string, string> = {
  "deny-intern": "interns may not escalate incidents",
  "allow-sre-open-tier1": "an SRE may escalate an open incident that affects a tier-1 service",
};

export function createWardenPolicyAuthority(): PolicyAuthority {
  const warden = createWarden({
    extensions: [{
      name: "recall",
      version: "1.0.0",
      conditions: [
        { name: "actor.role", evaluate: (req, expected) => (req.subject as { role?: string }).role === expected },
        { name: "incident.open", evaluate: (req) => (req.resource as EscalationFacts).incidentStatus === "open" },
        {
          name: "service.tierAtMost",
          evaluate: (req, expected) => {
            const tier = (req.resource as EscalationFacts).minServiceTier;
            return typeof expected === "number" && Number.isInteger(tier) && tier >= 1 && tier <= expected;
          },
        },
      ],
    }],
  });
  const chain = new AuditChain();

  return {
    async evaluate({ actorId, facts }) {
      let effect: "allow" | "deny" = "deny";
      let reason: string;
      let matchedRules: string[] = [];
      let code = "UNKNOWN_ACTOR";
      if (!isActorId(actorId)) {
        reason = `unknown actor "${String(actorId).slice(0, 40)}"`;
      } else {
        try {
          const d = await warden.evaluate(policy, {
            subject: ACTORS[actorId],
            action: { type: "incident.escalate" },
            resource: facts,
          });
          matchedRules = d.matchedRules;
          code = d.reasons[0]?.code ?? "NO_MATCH";
          if (d.effect === "ALLOW") { effect = "allow"; reason = REASONS["allow-sre-open-tier1"]; }
          else if (d.effect === "PENDING_APPROVAL") reason = "approval is required and not available";
          else if (code === "NO_MATCH") reason = "no policy rule allows this escalation (default deny)";
          else if (code === "EVALUATION_ERROR") reason = `policy evaluation failed: ${d.reasons[0]?.message ?? "unknown error"}`;
          else reason = (matchedRules.map((r) => REASONS[r]).filter(Boolean)[0] ?? "denied by policy");
        } catch (e) {
          reason = `policy unavailable: ${e instanceof Error ? e.message : "unknown error"}`;
          code = "POLICY_UNAVAILABLE";
        }
      }
      const entry = chain.append({
        eventId: `esc-${chain.entries.length + 1}`,
        eventType: "escalation.decision",
        occurredAt: new Date().toISOString(),
        actor: String(actorId).slice(0, 40),
        resourceId: facts.incidentId,
        payload: { effect, code, reason, matchedRules, teamId: facts.teamId, policyId: policy.id },
      });
      return { effect, reason, decisionId: entry.hash.slice(0, 16), policyId: policy.id, matchedRules };
    },
    audit: () => ({ entries: structuredClone(chain.entries), verification: verifyAuditChain(chain.entries) }),
  };
}
