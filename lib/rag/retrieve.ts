import { query } from "../db";
import type { Context } from "./ingest";

export interface RetrievedChunk {
  chunkId: number; content: string; documentId: number; title: string; tenantId: number;
}

export async function retrieve(ctx: Context, p: {
  tenantId: number; query: string; topK?: number;
}): Promise<RetrievedChunk[]> {
  const topK = p.topK ?? 5;
  const [emb] = await ctx.embed([p.query]);
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