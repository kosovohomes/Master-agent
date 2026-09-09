import { query } from "../db";
import crypto from "node:crypto";

export type Context = { embed(texts: string[]): Promise<number[][]> };

const CHUNK_SIZE = 800;

function chunkText(text: string): string[] {
  const out: string[] = [];
  let rest = text.replace(/\s+/g, " ").trim();
  while (rest.length > 0) {
    out.push(rest.slice(0, CHUNK_SIZE));
    rest = rest.slice(CHUNK_SIZE);
  }
  return out.length > 0 ? out : [""];
}

export async function addContentSource(ctx: Context, p: {
  tenantId: number; kind: "sitemap" | "upload" | "api"; ref: string;
}) {
  const rows = await query<{ id: number }>(
    `INSERT INTO content_sources (tenant_id, kind, ref) VALUES ($1, $2, $3) RETURNING id`,
    [p.tenantId, p.kind, p.ref]
  );
  return { sourceId: rows[0].id };
}

export async function ingestText(ctx: Context, p: {
  tenantId: number; sourceId: number; title: string; url?: string; text: string;
}) {
  const checksum = crypto.createHash("sha256").update(p.text).digest("hex");
  const docRows = await query<{ id: number }>(
    `INSERT INTO documents (tenant_id, source_id, title, url, checksum)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [p.tenantId, p.sourceId, p.title, p.url ?? null, checksum]
  );
  const documentId = docRows[0].id;
  const chunks = chunkText(p.text);
  const embeddings = await ctx.embed(chunks);
  for (let i = 0; i < chunks.length; i++) {
    await query(
      `INSERT INTO chunks (document_id, tenant_id, content, embedding)
       VALUES ($1, $2, $3, $4::vector)`,
      [documentId, p.tenantId, chunks[i], JSON.stringify(embeddings[i])]
    );
  }
  return { documentId, chunkCount: chunks.length };
}