import { createHash } from "node:crypto";
import { parse } from "yaml";
import { DocSchema, type Doc } from "./schemas.ts";

export class IngestError extends Error {}

export type ParsedDoc = { data: Doc; path: string; hash: string; title: string; body: string };

export function parseDocumentText(path: string, text: string): ParsedDoc {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new IngestError(`${path}: missing YAML frontmatter`);
  const meta = parse(m[1]);
  const body = m[2].trim();
  if (!body) throw new IngestError(`${path}: empty body`);
  const parsed = DocSchema.safeParse(meta);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new IngestError(`${path}: invalid frontmatter: ${issues}`);
  }
  const heading = /^#\s+(.+)$/m.exec(body)?.[1];
  const title = parsed.data.title ?? heading ?? parsed.data.id;
  return { data: parsed.data, path, hash: createHash("sha256").update(text).digest("hex"), title, body };
}
