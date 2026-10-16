import { z } from "zod";

const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "ids are lowercase kebab-case");
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?$/, "expected ISO-8601 UTC date")
  .refine((s) => !Number.isNaN(Date.parse(s)), "malformed date");
const ids = z.array(id).default([]);
const common = { id, title: z.string().optional() };

export const DocSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("service"), name: z.string(), tier: z.number().int().min(1).max(3), dependsOn: ids }),
  z.strictObject({ ...common, kind: z.literal("team"), name: z.string() }),
  z.strictObject({ ...common, kind: z.literal("person"), name: z.string(), role: z.string(), team: id, onCallFor: ids }),
  z.strictObject({
    ...common,
    kind: z.literal("ownership"),
    service: id,
    team: id,
    validFrom: isoDate,
    supersedes: id.nullable().default(null),
  }),
  z.strictObject({ ...common, kind: z.literal("adr"), service: id, date: isoDate, amends: id.nullable().default(null) }),
  z.strictObject({
    ...common,
    kind: z.literal("incident"),
    status: z.enum(["open", "resolved"]),
    severity: z.enum(["sev1", "sev2", "sev3"]),
    openedAt: isoDate,
    services: ids,
  }),
  z.strictObject({ ...common, kind: z.literal("project"), name: z.string(), uses: ids }),
]);

export type Doc = z.infer<typeof DocSchema>;
export type DocKind = Doc["kind"];
