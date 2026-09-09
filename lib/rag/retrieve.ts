import { query } from "../db";
import type { Context } from "./ingest";

export interface RetrievedChunk {
  chunkId: number; content: string; documentId: number; title: string; tenantId: number;
}

export async function retrieve(ctx: Context, p: {
  tenantId: number; query: string; topK?: number;
}): Promise<RetrievedChunk[]> {
  const topK = p.topK ?? 5;
  const vecs = await ctx.embed([p.query]);
  if (vecs.length !== 1) {
    throw new Error(`embed returned ${vecs.length} vector(s) for 1 input`);
  }
  const emb = vecs[0];
  return query<RetrievedChunk>(
    `SELECT c.id AS "chunkId", c.content, c.document_id AS "documentId",
            d.title, c.tenant_id AS "tenantId"
     FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE c.tenant_id = $1
     ORDER BY c.embedding <=> $2::vector
     LIMIT $3`,
    [p.tenantId, JSON.stringify(emb), topK]
  );
}